/**
 * Tapbacks that arrived as live events while the page was open. Only these animate in (and sound);
 * reactions already in a loaded transcript stay still. Keyed by the reaction's own timestamp.
 */
const fresh = new Set<string>();
export const reactionKey = (botId: string, seq: number, at: number) => `${botId}:${seq}:${at}`;
/** Long enough for the badge to mount and play its add animation once. */
const FRESH_MS = 3000;
export function noteLiveReaction(key: string) {
  fresh.add(key);
  setTimeout(() => fresh.delete(key), FRESH_MS);
}
export function isLiveReaction(key: string) { return fresh.has(key); }
