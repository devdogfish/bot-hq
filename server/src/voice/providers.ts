import type { VoiceProviderId } from '../types.js';
import { ELEVENLABS_DEFAULT_VOICE } from './elevenlabs-config.js';
import { elevenlabsProvider } from './elevenlabs.js';
import { xaiProvider } from './xai.js';

export const voiceProviders = { xai: xaiProvider, elevenlabs: elevenlabsProvider };

export function isVoiceProviderId(id: unknown): id is VoiceProviderId {
  return id === 'xai' || id === 'elevenlabs';
}

export function providerFor(id: unknown) {
  return voiceProviders[isVoiceProviderId(id) ? id : 'xai'];
}

export function defaultVoiceFor(id: VoiceProviderId) {
  return id === 'elevenlabs' ? ELEVENLABS_DEFAULT_VOICE : 'luna';
}
