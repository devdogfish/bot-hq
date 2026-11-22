/**
 * Agent messages that just finished arriving live, so their bubble can play the arrival motion once.
 * Messages already in a loaded transcript stay still.
 */
const fresh = new Set<string>();
const FRESH_MS = 3000;
export const arrivalKey = (botId: string, seq: number) => `${botId}:${seq}`;
export function noteArrival(key: string) {
  fresh.add(key);
  setTimeout(() => fresh.delete(key), FRESH_MS);
}
export function isArrival(key: string) { return fresh.has(key); }
