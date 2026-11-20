import { env } from '../env.js';
import type { VoiceOption } from '../types.js';
import type { VoiceProvider } from './provider.js';
import { MEETING_TOOLS, VOICE_TOOLS } from './tools.js';

export const XAI = 'https://api.x.ai/v1';
const VOICE_MODEL = process.env.XAI_VOICE_MODEL ?? 'grok-voice-latest';
const STT_MODEL = process.env.XAI_STT_MODEL ?? 'grok-voice-transcribe-2.0';
const SAMPLE_RATE = 24000;
const xaiHeaders = () => ({ Authorization: `Bearer ${env.xaiKey}` });

const FALLBACK_VOICES: VoiceOption[] = [
  ['altair', 'm'], ['ara', 'f'], ['atlas', 'm'], ['aurora', 'f'], ['carina', 'f'], ['castor', 'm'], ['celeste', 'f'], ['cosmo', 'm'],
  ['eve', 'f'], ['helios', 'm'], ['helix', 'm'], ['iris', 'f'], ['kepler', 'm'], ['leo', 'm'], ['liora', 'f'], ['lumen', 'm'],
  ['luna', 'f'], ['lux', 'm'], ['naksh', 'm'], ['orion', 'm'], ['perseus', 'm'], ['rex', 'm'], ['rigel', 'm'], ['sal', 'm'],
  ['sirius', 'm'], ['ursa', 'f'], ['zagan', 'm'], ['zenith', 'm'],
].map(([id, g]) => ({ id, name: id[0].toUpperCase() + id.slice(1), gender: g === 'f' ? 'female' : 'male' }));

let voiceCache: { at: number; voices: VoiceOption[] } | null = null;
async function listVoices(): Promise<VoiceOption[]> {
  if (voiceCache && Date.now() - voiceCache.at < 3600_000) return voiceCache.voices;
  try {
    const r = await fetch(`${XAI}/tts/voices`, { headers: xaiHeaders(), signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { voices?: { voice_id: string; name?: string; gender?: string }[] };
    const voices = (j.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name ?? v.voice_id, gender: v.gender }));
    if (!voices.length) throw new Error('empty list');
    voiceCache = { at: Date.now(), voices };
  } catch (e: any) {
    console.warn('[voice] voice list unavailable, using static list:', e?.message);
    voiceCache = { at: Date.now() - 3000_000, voices: FALLBACK_VOICES }; // retry in ~10 min
  }
  return voiceCache.voices;
}

export async function startXaiSession(
  s: Omit<Parameters<VoiceProvider['startSession']>[0], 'userFirstName'>,
  mode: 'voice' | 'meeting' = 'voice',
) {
  const r = await fetch(`${XAI}/realtime/client_secrets`, {
    method: 'POST',
    redirect: 'error',
    headers: { ...xaiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expires_after: { seconds: 300 } }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!r?.ok) {
    console.warn('[voice] client secret mint failed', r?.status ?? 'network error');
    return null;
  }
  const secret = await r.json().catch(() => null) as { value?: string; expires_at: number } | null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof secret?.value !== 'string' || !secret.value || secret.value === env.xaiKey ||
      !Number.isInteger(secret.expires_at) || secret.expires_at <= now || secret.expires_at > now + 360) return null;

  const tools = mode === 'meeting' ? MEETING_TOOLS : VOICE_TOOLS;

  const instructions = s.instructions();
  const session: Record<string, unknown> = {
    voice: s.voice,
    instructions,
    turn_detection: mode === 'meeting' ? null : { type: 'server_vad' },
    tools,
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: SAMPLE_RATE },
        transcription: { model: 'grok-transcribe', ...(s.language !== 'auto' ? { language_hint: s.language } : {}) },
      },
      output: { format: { type: 'audio/pcm', rate: SAMPLE_RATE }, speed: s.speed },
    },
  };

  return {
    provider: 'xai' as const,
    clientSecret: secret.value,
    expiresAt: secret.expires_at,
    model: VOICE_MODEL,
    websocketUrl: `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(VOICE_MODEL)}`,
    sampleRate: SAMPLE_RATE,
    instructions,
    voice: s.voice,
    speed: s.speed,
    language: s.language,
    tools,
    session,
  };
}

export const xaiProvider: VoiceProvider = {
  id: 'xai',
  name: 'xAI',
  get available() { return !!env.xaiKey; },
  unavailableMessage: 'Set XAI_API_KEY to use voice.',
  listVoices,
  startSession: startXaiSession,
  async preview({ voice, language, text, speed, codec }) {
    const r = await fetch(`${XAI}/tts`, {
      method: 'POST',
      headers: { ...xaiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice_id: voice, language, speed, output_format: { codec, sample_rate: SAMPLE_RATE } }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!r?.ok) {
      console.warn('[voice] tts failed', r?.status, (await r?.text().catch(() => ''))?.slice(0, 200));
      return null;
    }
    return {
      body: await r.arrayBuffer(),
      contentType: codec === 'pcm' ? `audio/pcm;rate=${SAMPLE_RATE}` : 'audio/mpeg',
    };
  },
  async transcribe(file, lang) {
    const out = new FormData();
    out.append('model', STT_MODEL);
    if (lang && lang !== 'auto' && /^[a-z]{2}$/.test(lang)) out.append('language', lang);
    out.append('file', file, file.name || 'dictation.webm'); // must be last
    const r = await fetch(`${XAI}/stt`, { method: 'POST', headers: xaiHeaders(), body: out, signal: AbortSignal.timeout(60_000) }).catch(() => null);
    if (!r?.ok) {
      console.warn('[voice] stt failed', r?.status, (await r?.text().catch(() => ''))?.slice(0, 200));
      return null;
    }
    const j = (await r.json()) as { text?: string };
    return (j.text ?? '').trim();
  },
};
