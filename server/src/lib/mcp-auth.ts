import crypto from 'node:crypto';
import { db } from '../db.js';
import { mcpToken, primaryBotId } from '../engine.js';
import { getBotRow } from '../store.js';
import { isPersonalAssistant } from '../agent/personal-assistant.js';

function matchesToken(slug: string, token: Buffer) {
  const expected = Buffer.from(mcpToken(slug));
  return token.length === expected.length && crypto.timingSafeEqual(token, expected);
}

function callerForSlug(slug: string): { botId: string | null } | null {
  if (slug === 'primary') {
    const botId = primaryBotId();
    return isPersonalAssistant(botId) ? null : { botId };
  }
  return getBotRow(slug) ? { botId: slug } : null;
}

/** Verify MCP requests, where the route supplies the credential's slug. */
export function mcpCaller(slug: string, auth: string | undefined) {
  const token = Buffer.from((auth ?? '').replace(/^Bearer\s+/i, '').trim());
  return matchesToken(slug, token) ? callerForSlug(slug) : null;
}

/** Resolve a bot from its existing MCP credential on routes without a bot slug. */
export function botFromMcpBearer(auth: string | undefined): string | null {
  const value = auth?.match(/^Bearer\s+([a-f0-9]{64})$/i)?.[1];
  if (!value) return null;
  const token = Buffer.from(value);
  if (matchesToken('primary', token)) return callerForSlug('primary')?.botId ?? null;
  // MCP tokens are opaque HMACs. Match against current bot IDs to recover the bound bot.
  for (const { id } of db.prepare('SELECT id FROM bots').iterate() as Iterable<{ id: string }>) {
    if (matchesToken(id, token)) return id;
  }
  return null;
}
