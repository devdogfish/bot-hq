import { db } from '../db.js';
import { env } from '../env.js';
import { isPersonalAssistant } from './personal-assistant.js';

/**
 * Who a Bot is and who is on its team: the one description every channel uses (text chat, voice
 * calls, meetings), so an Agent knows the same things about itself and its teammates wherever the
 * Owner talks to it. No clock or per-turn state: text chat keeps this in its cached prompt.
 */

export interface Teammate { name: string; label: string; description: string; isPrimary: boolean }

/** Other active Agents on the team. The Personal Assistant is private to the Owner (Quantself ADR 0060), so never listed. */
export function teammates(userId: string, botId: string): Teammate[] {
  return (db.prepare(`SELECT id, name, label, description, is_primary FROM bots
      WHERE user_id=? AND id<>? AND archived_at IS NULL AND COALESCE(hidden,0)=0 AND COALESCE(kind,'agent')<>'room'
      ORDER BY is_primary DESC, created_at ASC`).all(userId, botId) as any[])
    .filter((b) => !isPersonalAssistant(b.id))
    .map((b) => ({ name: b.name, label: b.label ?? '', description: b.description ?? '', isPrimary: !!b.is_primary }));
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * @param owner how to name the Owner: their name, or "the Owner" where the name must stay out.
 * @param bringIn how this channel involves a teammate, e.g. "with send_to_bot".
 * @param situation where this conversation happens, e.g. "in a live meeting".
 */
export function identity(bot: any, userId: string, owner: string, bringIn: string, situation = ''): string {
  const team = env.teamName ? `${owner}'s ${env.teamName} team` : `${owner}'s team`;
  const lines = [
    `You are ${bot.name}${bot.label ? `, ${bot.label}` : ''}${situation ? `, ${situation}` : ''}. You are an AI coworker on ${team}, and ${owner} is your boss.`
      + (bot.description ? ` ${clip(String(bot.description), 400)}` : '')
      + (bot.is_primary ? ` You are ${owner}'s main point of contact and coordinate the team.` : ''),
  ];
  if (isPersonalAssistant(bot.id)) return lines.join('\n');
  const mates = teammates(userId, bot.id);
  if (!mates.length) return [...lines, 'You are the only Agent on the team so far.'].join('\n');
  lines.push('Your teammates:');
  for (const m of mates) {
    const role = [m.label, m.description && clip(m.description, 200)].filter(Boolean).join('. ');
    lines.push(`- ${m.name}${role ? `: ${role}` : ''}${m.isPrimary ? ' (main point of contact)' : ''}`);
  }
  lines.push(`You know who does what. When work belongs to a teammate, or a teammate knows something you need, bring them in ${bringIn}. Never invent teammates or what they are doing.`);
  return lines.join('\n');
}
