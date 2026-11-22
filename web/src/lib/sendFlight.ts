/**
 * The iMessage send motion: the composer records where the text left from, and the new user bubble
 * rises from there into its place in the transcript when its row arrives.
 */
const FLIGHT_MS = 8000;
let pending: { botId: string; text: string; rect: DOMRect; at: number } | null = null;

export function markSent(botId: string, text: string, rect: DOMRect) {
  pending = { botId, text, rect, at: Date.now() };
}

/** Where the bubble with this text should rise from, once. Null when it was not just sent from here. */
export function takeFlight(botId: string, text: string): DOMRect | null {
  const p = pending;
  if (!p || p.botId !== botId || p.text !== text.trim() || Date.now() - p.at > FLIGHT_MS) return null;
  pending = null;
  return p.rect;
}
