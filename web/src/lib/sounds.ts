import type { SoundSet } from '@shared/types';
import { useStore } from '../store';

/**
 * Short sounds (web/public/sounds/README.md): the Owner's own click when they send, "Intuition" when an
 * Agent's reply arrives, "Accomplished" instead when that reply ends a long piece of work, and a bubble pop
 * when a tapback lands. They play quietly, only while the tab is visible, never under
 * prefers-reduced-motion, and never when the Owner picked None.
 */
export type SoundRole = 'send' | 'receive' | 'done' | 'reaction';

/** A turn that has worked this long has finished something worth a small celebration. */
export const LONG_TURN_MS = 60_000;
const celebrated = new Map<string, number>();

/**
 * Which sound an Agent's reply gets: Accomplished for the first reply of a turn that ran a minute or
 * more, nothing for later replies of that same turn, Intuition otherwise.
 */
export function replySound(botId: string, startedAt: number | null | undefined, now = Date.now()): SoundRole | null {
  if (startedAt && celebrated.get(botId) === startedAt) return null;
  if (startedAt && now - startedAt >= LONG_TURN_MS) {
    celebrated.set(botId, startedAt);
    return 'done';
  }
  return 'receive';
}

export const SOUND_SET_OPTIONS: { id: SoundSet; label: string; hint: string }[] = [
  { id: 'hollow_bubble', label: 'Bot HQ sounds', hint: 'Send, reply, finished work and reaction' },
  { id: 'none', label: 'None', hint: 'No sounds' },
];

/** The file for each moment. */
const FILES: Record<SoundRole, string> = { send: 'send/send', receive: 'intuition/receive', done: 'accomplished/done', reaction: 'bubble/pop' };

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

/** Settings preview: send, reply, finished work, then reaction, regardless of visibility rules. */
export function previewSoundSet(set: SoundSet) {
  play(set, 'send');
  setTimeout(() => play(set, 'receive'), 500);
  setTimeout(() => play(set, 'done'), 1400);
  setTimeout(() => play(set, 'reaction'), 2500);
}
