import { db, now } from '../db.js';
import { sha256 } from '../lib/ids.js';
import { deliverOwnerEmail, OWNER_EMAIL_ROLES, ownerEmailTransportConfigured, type OwnerEmailPacket,
  type OwnerEmailRole } from './owner-email-transport.js';

interface EmailTurn {
  botId: string;
  generation: number;
  ownerSeq: number;
  review: boolean;
  intentHash: string;
  envelope: { from: string; to: string[] };
}

type EmailStatus = 'review' | 'sending' | 'accepted' | 'rejected' | 'uncertain' | 'skipped';

export interface OwnerEmailOutcome {
  status: EmailStatus | 'draft_only' | 'conflict';
  messageId?: string;
}

// Select senders by immutable Bot HQ record ID here, never a model-supplied role or display name.
export function ownerEmailRole(botId: string | null): OwnerEmailRole | undefined {
  if (!botId || !ownerEmailTransportConfigured()) return;
  const config = process.env.HQ_OWNER_EMAIL_TARGETS;
  if (!config) return;
  try {
    const value: unknown = JSON.parse(config);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const targets = Object.entries(value);
    if (targets.some(([role, id]) => !OWNER_EMAIL_ROLES.some((known) => known === role)
        || typeof id !== 'string' || !/^bot_[A-Za-z0-9_-]{1,64}$/.test(id))
        || new Set(targets.map(([, id]) => id)).size !== targets.length) return;
    return targets.find(([, id]) => id === botId)?.[0] as OwnerEmailRole | undefined;
  } catch {
    return;
  }
}

const where = 'bot_id=? AND generation=? AND owner_seq=?';

export async function dispatchOwnerEmail(
  turn: EmailTurn,
  packet: OwnerEmailPacket,
  eligible: () => boolean,
  approve: () => Promise<boolean>,
  deliver = deliverOwnerEmail,
): Promise<OwnerEmailOutcome> {
  if (!eligible()) return { status: 'draft_only' };
  const identity = [turn.botId, turn.generation, turn.ownerSeq];
  const payloadHash = sha256(JSON.stringify([turn.envelope.from, turn.envelope.to, packet.subject, packet.body]));
  const first = turn.review ? 'review' : 'sending';
  const reserved = db.prepare(`INSERT OR IGNORE INTO owner_email_sends
    (bot_id,generation,owner_seq,payload_hash,intent_hash,status,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (
      SELECT 1 FROM owner_email_sends WHERE bot_id=? AND status IN ('sending','uncertain')
        AND (payload_hash=? OR intent_hash=?)
    )`).run(...identity, payloadHash, turn.intentHash, first, now(), now(), turn.botId, payloadHash, turn.intentHash);
  if (!reserved.changes) {
    const existing = db.prepare(`SELECT status,message_id,payload_hash FROM owner_email_sends WHERE ${where}`)
      .get(...identity) as { status: EmailStatus; message_id: string | null; payload_hash: string } | undefined;
    if (!existing) return { status: 'uncertain' };
    if (existing.payload_hash !== payloadHash) return { status: 'conflict' };
    return { status: existing.status, ...(existing.message_id ? { messageId: existing.message_id } : {}) };
  }
  const settle = (status: EmailStatus, messageId: string | null = null) => {
    db.prepare(`UPDATE owner_email_sends SET status=?,message_id=?,updated_at=? WHERE ${where}`)
      .run(status, messageId, now(), ...identity);
    return { status, ...(messageId ? { messageId } : {}) };
  };
  if (turn.review) {
    const allowed = await approve().catch(() => false);
    if (!allowed || !eligible()) return settle('skipped');
    settle('sending');
  }

  // A durable sending row is written before the API call. An interrupted or uncertain
  // submission cannot be retried from this turn, including after a process restart.
  if (!eligible()) return settle('skipped');
  try {
    const result = await deliver(packet);
    if (result.kind === 'accepted') return settle('accepted', result.messageId);
    return settle(result.kind);
  } catch {
    return settle('uncertain');
  }
}
