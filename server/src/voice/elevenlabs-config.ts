export const ELEVENLABS_API = 'https://api.elevenlabs.io';
export const ELEVENLABS_DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL'; // Sarah

export function elevenlabsLanguage(tag: string) {
  const code = tag.toLowerCase().split('-')[0];
  return /^[a-z]{2}$/.test(code) ? code : undefined;
}
