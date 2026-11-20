export const LANGUAGES: { code: string; name: string }[] = [
  { code: 'auto', name: 'Auto-detect' }, { code: 'en', name: 'English' }, { code: 'ar-EG', name: 'Arabic (Egypt)' },
  { code: 'ar-SA', name: 'Arabic (Saudi Arabia)' }, { code: 'ar-AE', name: 'Arabic (UAE)' }, { code: 'bn', name: 'Bengali' },
  { code: 'zh', name: 'Chinese' }, { code: 'fr', name: 'French' }, { code: 'de', name: 'German' }, { code: 'hi', name: 'Hindi' },
  { code: 'id', name: 'Indonesian' }, { code: 'it', name: 'Italian' }, { code: 'ja', name: 'Japanese' }, { code: 'ko', name: 'Korean' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)' }, { code: 'pt-PT', name: 'Portuguese (Portugal)' }, { code: 'ru', name: 'Russian' },
  { code: 'es-MX', name: 'Spanish (Mexico)' }, { code: 'es-ES', name: 'Spanish (Spain)' }, { code: 'tr', name: 'Turkish' }, { code: 'vi', name: 'Vietnamese' },
];
export const SPEEDS = [0.7, 0.85, 1, 1.15, 1.3, 1.5];

export const clampSpeed = (s: unknown, max = 1.5) => {
  const n = Number(s);
  return Number.isFinite(n) ? Math.min(max, Math.max(0.7, n)) : 1;
};
export const langName = (code?: string) => LANGUAGES.find((l) => l.code.toLowerCase() === code?.toLowerCase())?.name;
export function settingsOf(bot: { voice?: string; voice_speed?: number; voice_language?: string }, defaultVoice: string) {
  const language = langName(bot.voice_language) ? String(bot.voice_language) : 'auto';
  return { voice: String(bot.voice || defaultVoice), speed: clampSpeed(bot.voice_speed ?? 1), language };
}
