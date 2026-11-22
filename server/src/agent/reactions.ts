import { db } from '../db.js';
import { getBotRow, updateRow } from '../store.js';
import { parseReaction, REACTION_KINDS, type MessageBody } from '../types.js';

export const REACT_TOOL = 'react_to_message';
export const REACT_TOOL_DESCRIPTION = "Put an iMessage-style reaction on one of the Owner's messages, when a quick reaction says it better than words (thanks, approval, a joke, a surprise). Use a tapback (heart, thumbs_up, thumbs_down, haha, emphasis, question) or any single emoji such as 🤩. One reaction per message; a new one replaces the old, and 'none' removes it. Targets the Owner's latest message unless message_text picks an earlier one. A reaction does not replace a reply the Owner needs.";
export const REACT_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    reaction: { type: 'string', description: `One of ${REACTION_KINDS.join(', ')}; any single emoji, e.g. 🤩; or none to remove it.` },
    message_text: { type: 'string', description: "A few words from the Owner's message to react to. Leave out for their latest message." },
  },
  required: ['reaction'],
  additionalProperties: false,
};

/** How far back an Agent can reach for a message to react to. */
const LOOKBACK = 40;

const isOwnerMessage = (b: any): b is MessageBody =>
  b?.type === 'message' && b.role === 'user' && (!b.from || b.from.kind === 'voice');

/**
 * Set or clear the Agent's tapback on one of the Owner's recent messages. Without `messageText` it targets
 * the Owner's latest message; otherwise the newest one whose text contains it.
 */
export function reactToMessage(botId: string, reaction: string, messageText?: string): { ok: true; summary: string } | { ok: false; error: string } {
  const parsed = parseReaction(reaction);
  if (!parsed) return { ok: false, error: `Unknown reaction. Use one of: ${REACTION_KINDS.join(', ')}, a single emoji, or none.` };
  const clear = parsed === 'none';
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
    else next.reaction = { ...parsed, at: Date.now() };
    updateRow(botId, r.seq, next, bot.generation);
    const preview = body.text.length > 40 ? `${body.text.slice(0, 40)}…` : body.text;
    return { ok: true, summary: clear ? `Removed the reaction on “${preview}”` : `Reacted ${reaction} to “${preview}”` };
  }
  return { ok: false, error: needle ? 'No recent message from the Owner contains that text.' : 'The Owner has no recent message to react to.' };
}
