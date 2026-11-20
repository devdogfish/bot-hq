import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { isPersonalAssistant } from '../agent/personal-assistant.js';
import { botFromMcpBearer, mcpCaller } from '../lib/mcp-auth.js';
import { getBotRow } from '../store.js';
import { beginCall, finishMeeting, ownCall, relayVoiceTool, voiceInstructions } from '../voice/index.js';
import { defaultVoiceFor } from '../voice/providers.js';
import { settingsOf } from '../voice/settings.js';
import { MEETING_TOOLS } from '../voice/tools.js';
import { startXaiSession, xaiProvider } from '../voice/xai.js';
import { decideTurn } from './gate.js';

interface MeetingBot {
  id: string;
  user_id: string;
  name: string;
  kind: string;
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
const callRequest = z.object({ call_id: z.string().regex(/^call_[\w-]{12}$/) });
const turn = z.object({
  speaker: z.string().trim().min(1).max(256),
  text: z.string().max(16_000),
  at: z.number().nonnegative(),
});
const gateRequest = callRequest.extend({ transcript: z.array(turn).max(24), last_agent_turn_at: z.number().nonnegative().nullable() });
const toolRequest = callRequest.extend({
  name: z.string().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()),
});
const endRequest = callRequest.extend({ transcript: z.array(turn).max(10_000) });

function meetingCall(bot: MeetingBot, id: string) {
  const call = ownCall(bot.user_id, bot.id, id);
  return call?.mode === 'meeting' && call.generation === bot.generation ? call : undefined;
}

type MeetingEnv = { Variables: { bot: MeetingBot; body: unknown } };
export const meetingApi = new Hono<MeetingEnv>();

function authenticatedAs(botId: string, bearer: string | undefined) {
  return mcpCaller(botId, bearer)?.botId === botId || mcpCaller('primary', bearer)?.botId === botId;
}

function meetingRequest(maxSize: number, perMinute: number) {
  const windows = new Map<string, { count: number; until: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [id, window] of windows) if (window.until <= now) windows.delete(id);
  }, 60_000).unref();

  const authenticate = createMiddleware<MeetingEnv>(async (c, next) => {
    const botId = botFromMcpBearer(c.req.header('authorization'));
    const bot = botId ? getBotRow(botId) as MeetingBot | undefined : undefined;
    if (!bot) return c.json({ error: 'unauthenticated' }, 401);
    const now = Date.now();
    const previous = windows.get(bot.id);
    const window = previous && previous.until > now ? previous : { count: 0, until: now + 60_000 };
    if (window.count >= perMinute) {
      return c.json({ error: 'Too many meeting requests' }, 429, { 'Retry-After': String(Math.ceil((window.until - now) / 1000)) });
    }
    window.count++;
    windows.set(bot.id, window);
    c.set('bot', bot);
    await next();
  });

  const parse = createMiddleware<MeetingEnv>(async (c, next) => {
    const body = await c.req.json().catch(() => null);
    const { id } = c.get('bot');
    // Reading the body yields. Resolve the bot again in case primary was reassigned.
    if (!authenticatedAs(id, c.req.header('authorization'))) return c.json({ error: 'unauthenticated' }, 401);
    c.set('bot', getBotRow(id));
    c.set('body', body);
    await next();
  });

  return [authenticate, bodyLimit({ maxSize, onError: (c) => c.json({ error: 'Meeting request too large' }, 413) }), parse] as const;
}

meetingApi.post('/session', ...meetingRequest(16 * 1024, 6), async (c) => {
  const request = sessionRequest.safeParse(c.get('body'));
  if (!request.success) return c.json({ error: 'Invalid meeting URL or platform' }, 400);
  const bot = c.get('bot');
  if (bot.archived_at != null || bot.paused || bot.kind === 'room' || isPersonalAssistant(bot.id)) return c.json({ error: 'Bot unavailable' }, 409);
  if (!xaiProvider.available) return c.json({ error: xaiProvider.unavailableMessage }, 503);

  const fallbackVoice = defaultVoiceFor('xai');
  const settings = settingsOf({ ...bot, voice: bot.voice_provider === 'elevenlabs' ? fallbackVoice : bot.voice }, fallbackVoice);
  const session = await startXaiSession({
    ...settings,
    instructions: () => voiceInstructions(bot.user_id, bot, settings.language, 'meeting'),
  }, 'meeting');
  if (!session) return c.json({ error: 'Could not start a meeting session' }, 502);

  // In particular, /mcp/primary can be rebound while the secret is being minted.
  if (!authenticatedAs(bot.id, c.req.header('authorization'))) return c.json({ error: 'unauthenticated' }, 401);
  const current = getBotRow(bot.id) as MeetingBot | undefined;
  if (!current || current.archived_at != null || current.paused || current.generation !== bot.generation || isPersonalAssistant(bot.id)) {
    return c.json({ error: 'Bot unavailable' }, 409);
  }

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

meetingApi.post('/gate', ...meetingRequest(512 * 1024, 120), (c) => {
  const request = gateRequest.safeParse(c.get('body'));
  if (!request.success) return c.json({ error: 'Invalid gate request' }, 400);
  const { call_id, transcript, last_agent_turn_at } = request.data;
  const bot = c.get('bot');
  const call = meetingCall(bot, call_id);
  if (!call) return c.json({ error: 'Call not found' }, 404);

  if (bot.archived_at != null || bot.paused) return c.json({ decision: 'silent' });
  call.lastActivityAt = Date.now();
  const decision = decideTurn({
    agentName: bot.name,
    aliases: [],
    transcript,
    lastAgentTurnAt: last_agent_turn_at,
    mutedByRequest: call.mutedByRequest,
    // Roster display names are participant-supplied, with no verified moderator identity.
    ownerSpeaker: '',
  });
  if (typeof decision === 'object') {
    call.mutedByRequest = decision.action === 'mute';
    return c.json({ decision: 'silent', action: decision.action });
  }
  // A classifier reading participant dialogue cannot grant the floor for an ambiguous turn.
  return c.json({ decision: decision === 'ask_llm' ? 'silent' : decision });
});

meetingApi.post('/tool', ...meetingRequest(16 * 1024, 12), (c) => {
  const request = toolRequest.safeParse(c.get('body'));
  if (!request.success) return c.json({ error: 'Invalid tool request' }, 400);
  const { call_id, name, arguments: args } = request.data;
  const bot = c.get('bot');
  const call = meetingCall(bot, call_id);
  if (!call) return c.json({ error: 'Call not found' }, 404);
  if (bot.archived_at != null) return c.json({ error: 'Bot unavailable' }, 409);
  if (!MEETING_TOOLS.some((tool) => tool.name === name)) return c.json({ error: 'Tool unavailable in meetings' }, 403);
  call.lastActivityAt = Date.now();
  return c.json(relayVoiceTool(bot, name, args, call));
});

meetingApi.post('/end', ...meetingRequest(2 * 1024 * 1024, 12), (c) => {
  const request = endRequest.safeParse(c.get('body'));
  if (!request.success) return c.json({ error: 'Invalid end request' }, 400);
  const { call_id, transcript } = request.data;
  const bot = c.get('bot');
  const agentName = bot.name.normalize('NFKC').trim().toLowerCase();
  const lines = transcript.map((turn) => ({
    ...turn,
    role: turn.speaker.normalize('NFKC').toLowerCase() === agentName ? 'assistant' as const : 'user' as const,
  }));
  const seq = finishMeeting(bot, call_id, lines);
  return seq === null ? c.json({ error: 'Call not found' }, 404) : c.json({ ok: true, seq });
});
