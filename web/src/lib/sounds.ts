import type { SoundSet } from '@shared/types';
import { useStore } from '../store';

/**
 * Short interface sounds for send, receive and tapbacks. CC0 files from Kenney's Interface Sounds pack,
 * trimmed and level-matched (web/public/sounds/LICENSE.txt). They play quietly, only while the tab is
 * visible, never under prefers-reduced-motion, and never when the Owner picked None.
 */
export type SoundRole = 'send' | 'receive' | 'reaction';

export const SOUND_SET_OPTIONS: { id: SoundSet; label: string; hint: string }[] = [
  { id: 'glass', label: 'Glass', hint: 'Soft glass taps' },
  { id: 'pluck', label: 'Pluck', hint: 'Rounded drops and plucks' },
  { id: 'tick', label: 'Tick', hint: 'Tiny dry ticks' },
  { id: 'tap', label: 'Tap', hint: 'Barely-there clicks' },
  { id: 'none', label: 'None', hint: 'No sounds' },
];

const VOLUME = 0.35;
const MIN_GAP_MS = 120;
const cache = new Map<string, HTMLAudioElement>();
const lastPlayed: Partial<Record<SoundRole, number>> = {};

function play(set: SoundSet, role: SoundRole) {
  if (set === 'none') return;
  const src = `/sounds/${set}/${role}.mp3`;
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
  play(useStore.getState().user?.soundSet ?? 'glass', role);
}

/** Settings preview: send, receive and reaction of one set, a beat apart, regardless of visibility rules. */
export function previewSoundSet(set: SoundSet) {
  (['send', 'receive', 'reaction'] as SoundRole[]).forEach((role, i) => setTimeout(() => play(set, role), i * 420));
}
