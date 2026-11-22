import { db } from '../db.js';
import { getBotRow, updateRow } from '../store.js';
import { REACTION_KINDS, type MessageBody, type ReactionKind } from '../types.js';

/** How far back an Agent can reach for a message to react to. */
const LOOKBACK = 40;

const isOwnerMessage = (b: any): b is MessageBody =>
  b?.type === 'message' && b.role === 'user' && (!b.from || b.from.kind === 'voice');

/**
 * Set or clear the Agent's tapback on one of the Owner's recent messages. Without `messageText` it targets
 * the Owner's latest message; otherwise the newest one whose text contains it.
 */
export function reactToMessage(botId: string, reaction: string, messageText?: string): { ok: true; summary: string } | { ok: false; error: string } {
  const clear = reaction === 'none';
  if (!clear && !(REACTION_KINDS as readonly string[]).includes(reaction)) {
    return { ok: false, error: `Unknown reaction. Use one of: ${REACTION_KINDS.join(', ')}, or none.` };
  }
  const bot = getBotRow(botId);
  if (!bot) return { ok: false, error: 'No such Agent.' };
  const rows = db.prepare('SELECT seq, body FROM rows WHERE bot_id=? AND generation=? AND kind=? ORDER BY seq DESC LIMIT ?')
    .all(botId, bot.generation, 'message', LOOKBACK) as { seq: number; body: string }[];
  const needle = messageText?.trim().toLowerCase();
  for (const r of rows) {
    const body = JSON.parse(r.body);
    if (!isOwnerMessage(body)) continue;
    if (needle && !body.text.toLowerCase().includes(needle)) continue;
    const next: MessageBody = { ...body };
    if (clear) delete next.reaction;
    else next.reaction = { kind: reaction as ReactionKind, at: Date.now() };
    updateRow(botId, r.seq, next, bot.generation);
    const preview = body.text.length > 40 ? `${body.text.slice(0, 40)}…` : body.text;
    return { ok: true, summary: clear ? `Removed the reaction on “${preview}”` : `Reacted ${reaction} to “${preview}”` };
  }
  return { ok: false, error: needle ? 'No recent message from the Owner contains that text.' : 'The Owner has no recent message to react to.' };
}
