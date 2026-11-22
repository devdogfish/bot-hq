import type { SoundSet } from '@shared/types';
import { useStore } from '../store';

/**
 * Two short sounds (web/public/sounds/README.md): "Hollow" when an Agent's reply arrives and a bubble pop
 * when a tapback lands. Sending is silent. They play quietly, only while the tab is visible, never under
 * prefers-reduced-motion, and never when the Owner picked None.
 */
export type SoundRole = 'receive' | 'reaction';

export const SOUND_SET_OPTIONS: { id: SoundSet; label: string; hint: string }[] = [
  { id: 'hollow_bubble', label: 'Hollow + Bubble', hint: 'A soft chime for replies, a pop for reactions' },
  { id: 'none', label: 'None', hint: 'No sounds' },
];

/** The file for each moment. */
const FILES: Record<SoundRole, string> = { receive: 'hollow/receive', reaction: 'bubble/pop' };

/** AAC where the browser plays it (Safari, Chrome, Edge), MP3 everywhere else. */
const EXT = typeof Audio !== 'undefined' && new Audio().canPlayType('audio/mp4; codecs="mp4a.40.2"') ? 'm4a' : 'mp3';

const VOLUME = 0.35;
const MIN_GAP_MS = 120;
const cache = new Map<string, HTMLAudioElement>();
const lastPlayed: Partial<Record<SoundRole, number>> = {};

function play(set: SoundSet, role: SoundRole) {
  if (set === 'none') return;
  const src = `/sounds/${FILES[role]}.${EXT}`;
  let base = cache.get(src);
  if (!base) { base = new Audio(src); base.preload = 'auto'; cache.set(src, base); }
  const a = base.cloneNode() as HTMLAudioElement;
  a.volume = VOLUME;
  a.play().catch(() => { /* blocked until the page has had a user gesture */ });
}

/** Play one of the Owner's sounds, if they are wanted right now. */
export function playSound(role: SoundRole) {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const t = Date.now();
  if (t - (lastPlayed[role] ?? 0) < MIN_GAP_MS) return;
  lastPlayed[role] = t;
  play(useStore.getState().user?.soundSet ?? 'hollow_bubble', role);
}

/** Settings preview: the reply chime, then the reaction pop, regardless of visibility rules. */
export function previewSoundSet(set: SoundSet) {
  play(set, 'receive');
  setTimeout(() => play(set, 'reaction'), 900);
}
