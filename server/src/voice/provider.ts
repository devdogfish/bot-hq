import type { VoiceOption, VoiceProviderId, VoiceSessionConfig } from '../types.js';

interface VoiceSettings {
  voice: string;
  language: string;
  speed: number;
}

export interface VoiceProvider {
  id: VoiceProviderId;
  name: string;
  available: boolean;
  unavailableMessage: string;
  startSession(settings: VoiceSettings & { instructions: () => string; userFirstName: string }): Promise<VoiceSessionConfig | null>;
  listVoices(): Promise<VoiceOption[]>;
  preview(settings: VoiceSettings & { text: string; codec: 'pcm' | 'mp3' }): Promise<{ body: ArrayBuffer; contentType: string } | null>;
  transcribe(file: File, language: string): Promise<string | null>;
}
