import { env } from '../env.js';
import type { VoiceOption } from '../types.js';
import { ELEVENLABS_API, elevenlabsLanguage } from './elevenlabs-config.js';
import type { VoiceProvider } from './provider.js';
import { clampSpeed } from './settings.js';

const SAMPLE_RATE = 24000;
const MAX_SPEED = 1.2;

const greetings: Record<string, string> = {
  ar: 'مرحبًا', bn: 'হ্যালো', zh: '你好', fr: 'Bonjour', de: 'Hallo', hi: 'नमस्ते',
  id: 'Halo', it: 'Ciao', ja: 'こんにちは', ko: '안녕하세요', pt: 'Olá', ru: 'Привет',
  es: 'Hola', tr: 'Merhaba', vi: 'Xin chào',
};

async function request(path: string, timeout: number, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set('xi-api-key', env.elevenlabsKey);
  const response = await fetch(`${ELEVENLABS_API}${path}`, {
    ...init, headers, signal: AbortSignal.timeout(timeout),
  }).catch(() => null);
  if (response?.ok) return response;
  // Provider error bodies may include sensitive request data.
  console.warn('[voice] ElevenLabs request failed', path.split('?')[0], response?.status ?? 'network error');
  return null;
}

let voiceCache: { at: number; voices: VoiceOption[] } | undefined;
async function listVoices(): Promise<VoiceOption[]> {
  if (voiceCache && Date.now() - voiceCache.at < 3600_000) return voiceCache.voices;
  const voices: VoiceOption[] = [];
  const query = new URLSearchParams({ page_size: '100' });
  do {
    const response = await request(`/v2/voices?${query}`, 8000);
    if (!response) return voiceCache?.voices ?? [];
    const page = await response.json().catch(() => null) as {
      voices: { voice_id: string; name?: string; labels?: { gender?: string } }[];
      has_more?: boolean;
      next_page_token?: string;
    } | null;
    if (!Array.isArray(page?.voices)) return voiceCache?.voices ?? [];
    voices.push(...page.voices.map((voice) => ({ id: voice.voice_id, name: voice.name ?? voice.voice_id, gender: voice.labels?.gender })));
    if (!page.has_more || !page.next_page_token || query.get('next_page_token') === page.next_page_token) break;
    query.set('next_page_token', page.next_page_token);
  } while (true);
  voiceCache = { at: Date.now(), voices };
  return voices;
}

export const elevenlabsProvider: VoiceProvider = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  get available() { return !!env.elevenlabsKey; },
  unavailableMessage: 'Set ELEVENLABS_API_KEY to use ElevenLabs voice.',
  listVoices,
  async startSession(settings) {
    const query = new URLSearchParams({ agent_id: env.elevenlabsAgentId });
    const response = await request(`/v1/convai/conversation/get-signed-url?${query}`, 15_000);
    const data = await response?.json().catch(() => null) as { signed_url?: string } | null | undefined;
    if (typeof data?.signed_url !== 'string' || !data.signed_url.startsWith('wss://')) return null;
    const language = elevenlabsLanguage(settings.language);
    const greeting = greetings[language ?? 'en'] ?? 'Hi';
    return {
      provider: 'elevenlabs',
      signedUrl: data.signed_url,
      initData: {
        type: 'conversation_initiation_client_data',
        conversation_config_override: {
          agent: {
            prompt: { prompt: settings.instructions() },
            first_message: settings.userFirstName ? `${greeting}, ${settings.userFirstName}!` : `${greeting}!`,
            ...(language ? { language } : {}),
          },
          tts: { voice_id: settings.voice, speed: clampSpeed(settings.speed, MAX_SPEED) },
        },
      },
    };
  },
  async preview({ voice, language, text, speed, codec }) {
    const outputFormat = codec === 'pcm' ? `pcm_${SAMPLE_RATE}` : 'mp3_44100_128';
    const languageCode = elevenlabsLanguage(language);
    const response = await request(`/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${outputFormat}`, 30_000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: languageCode === 'bn' ? 'eleven_v3' : 'eleven_flash_v2_5',
        language_code: languageCode,
        voice_settings: { speed: clampSpeed(speed, MAX_SPEED) },
      }),
    });
    if (!response) return null;
    return {
      body: await response.arrayBuffer(),
      contentType: codec === 'pcm' ? `audio/pcm;rate=${SAMPLE_RATE}` : 'audio/mpeg',
    };
  },
  async transcribe(file, language) {
    const form = new FormData();
    form.append('model_id', 'scribe_v2');
    const code = elevenlabsLanguage(language);
    if (code) form.append('language_code', code);
    form.append('file', file, file.name || 'dictation.webm');
    const response = await request('/v1/speech-to-text', 60_000, { method: 'POST', body: form });
    const data = await response?.json().catch(() => null) as { text?: string } | null | undefined;
    return typeof data?.text === 'string' ? data.text.trim() : null;
  },
};
