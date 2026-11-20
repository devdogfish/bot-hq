import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { botFromMcpBearer } from '../lib/mcp-auth.js';
import { getBotRow } from '../store.js';
import { beginCall, finishCall, ownCall, relayVoiceTool, voiceInstructions } from '../voice/index.js';
import { defaultVoiceFor } from '../voice/providers.js';
import { settingsOf } from '../voice/settings.js';
import { MEETING_TOOLS } from '../voice/tools.js';
import { startXaiSession, xaiProvider } from '../voice/xai.js';
import { decideTurn, llmGate } from './gate.js';

interface MeetingBot {
  id: string;
  user_id: string;
  name: string;
  generation: number;
  paused: boolean;
  archived_at: number | null;
  voice_provider: string;
  voice?: string;
  voice_language?: string;
  voice_speed?: number;
}

const sessionRequest = z.object({
  url: z.url({ protocol: /^https?$/ }).max(8192),
  platform: z.enum(['jitsi', 'google_meet', 'meet', 'zoom']),
});
const callRequest = z.object({ call_id: z.string().min(1) });
const transcript = z.array(z.object({
  speaker: z.string().trim().min(1).max(256),
  text: z.string().max(16_000),
  at: z.number().nonnegative(),
}));
const gateRequest = callRequest.extend({ transcript, last_agent_turn_at: z.number().nonnegative().nullable() });
const toolRequest = callRequest.extend({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});
const endRequest = callRequest.extend({ transcript });

function meetingCall(bot: MeetingBot, id: string) {
  const call = ownCall(bot.user_id, bot.id, id);
  return call?.mode === 'meeting' ? call : undefined;
}

export const meetingApi = new Hono<{ Variables: { bot: MeetingBot; body: unknown } }>();
meetingApi.use('*', bodyLimit({ maxSize: 2 * 1024 * 1024 }));
meetingApi.use('*', async (c, next) => {
  const body = await c.req.json().catch(() => null);
  const botId = botFromMcpBearer(c.req.header('authorization'));
  const bot = botId ? getBotRow(botId) as MeetingBot | undefined : undefined;
  if (!bot) return c.json({ error: 'unauthenticated' }, 401);
  c.set('bot', bot);
  c.set('body', body);
  await next();
});

meetingApi.post('/session', async (c) => {
  const request = sessionRequest.safeParse(c.get('body'));
  if (!request.success) return c.json({ error: 'Invalid meeting URL or platform' }, 400);
  const bot = c.get('bot');
  if (bot.archived_at != null || bot.paused) return c.json({ error: 'Bot unavailable' }, 409);
  if (!xaiProvider.available) return c.json({ error: xaiProvider.unavailableMessage }, 503);

  const fallbackVoice = defaultVoiceFor('xai');
  const settings = settingsOf({ ...bot, voice: bot.voice_provider === 'elevenlabs' ? fallbackVoice : bot.voice }, fallbackVoice);
  const session = await startXaiSession({
    ...settings,
    instructions: () => voiceInstructions(bot.user_id, bot, settings.language, 'meeting'),
  }, 'meeting');
  if (!session) return c.json({ error: 'Could not start a meeting session' }, 502);

  // In particular, /mcp/primary can be rebound while the secret is being minted.
  if (botFromMcpBearer(c.req.header('authorization')) !== bot.id) return c.json({ error: 'unauthenticated' }, 401);
  const current = getBotRow(bot.id) as MeetingBot | undefined;
  if (!current || current.archived_at != null || current.paused) return c.json({ error: 'Bot unavailable' }, 409);

  return c.json({
    call_id: beginCall(current, 'meeting'),
    provider: session.provider,
    client_secret: session.clientSecret,
    ws_url: session.websocketUrl,
    model: session.model,
    voice: session.voice,
    instructions: session.instructions,
    tools: session.tools,
    sample_rate: session.sampleRate,
  }, 200, { 'Cache-Control': 'no-store' });
});

meetingApi.post('/gate', async (c) => {
  const request = gateRequest.safeParse(c.get('body'));
  if (!request.success) return c.json({ error: 'Invalid gate request' }, 400);
  const { call_id, transcript, last_agent_turn_at } = request.data;
  const bot = c.get('bot');
  const call = meetingCall(bot, call_id);
  if (!call) return c.json({ error: 'Call not found' }, 404);

  const revision = ++call.gateRevision;
  if (bot.archived_at != null || bot.paused) return c.json({ decision: 'silent' });
  const decision = decideTurn({
    agentName: bot.name,
    aliases: [],
    transcript,
    lastAgentTurnAt: last_agent_turn_at,
    mutedByRequest: call.mutedByRequest,
  });
  if (typeof decision === 'object') {
    call.mutedByRequest = decision.action === 'mute';
    return c.json({ decision: 'silent', action: decision.action });
  }
  if (decision !== 'ask_llm') return c.json({ decision });

  const recentTurns = transcript.slice(-12).map(({ speaker, text }) => ({ speaker, text: text.slice(-2000) }));
  const result = await llmGate(JSON.stringify({ agent: bot.name, recentTurns }));
  const current = getBotRow(bot.id) as MeetingBot | undefined;
  if (call.gateRevision !== revision || !meetingCall(bot, call_id) || !current || current.paused || current.archived_at != null
    || botFromMcpBearer(c.req.header('authorization')) !== bot.id) return c.json({ decision: 'silent' });
  return c.json({ decision: result });
});

meetingApi.post('/tool', (c) => {
  const request = toolRequest.safeParse(c.get('body'));
  if (!request.success) return c.json({ error: 'Invalid tool request' }, 400);
  const { call_id, name, arguments: args } = request.data;
  const bot = c.get('bot');
  const call = meetingCall(bot, call_id);
  if (!call) return c.json({ error: 'Call not found' }, 404);
  if (bot.archived_at != null) return c.json({ error: 'Bot unavailable' }, 409);
  if (!MEETING_TOOLS.some((tool) => tool.name === name)) return c.json({ error: 'Tool unavailable in meetings' }, 403);
  return c.json(relayVoiceTool(bot, name, args, call));
});

meetingApi.post('/end', (c) => {
  const request = endRequest.safeParse(c.get('body'));
  if (!request.success) return c.json({ error: 'Invalid end request' }, 400);
  const { call_id, transcript } = request.data;
  const bot = c.get('bot');
  const call = meetingCall(bot, call_id);
  if (!call) return c.json({ error: 'Call not found' }, 404);
  const agentName = bot.name.normalize('NFKC').trim().toLowerCase();
  const lines = transcript.map((turn) => ({
    ...turn,
    role: turn.speaker.normalize('NFKC').toLowerCase() === agentName ? 'assistant' as const : 'user' as const,
  }));
  return c.json({ ok: true, seq: finishCall(call, bot.name, lines) });
});
