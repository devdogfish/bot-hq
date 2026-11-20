import { db } from './db.js';
import { env } from './env.js';
import { isHermesHealthy } from './hermes-health.js';
import { hub } from './lib/hub.js';
import { emitBot, insertRow } from './store.js';

const CHECK_INTERVAL_MS = 30_000;
const FAILURES_BEFORE_ALERT = 3;
const MAX_CONCURRENT_PROBES = 8;

const gatewayUrl = `COALESCE(NULLIF(b.hermes_url, ''), CASE
  WHEN @localEngines AND b.engine = 'primary' THEN @primaryUrl
  WHEN @localEngines AND b.engine = 'managed' THEN 'http://127.0.0.1:' || b.engine_port
END)`;
const gatewaySettings = { localEngines: Number(env.localEngines), primaryUrl: env.hermesUrl };
const visibleAgents = "COALESCE(b.kind, 'agent') <> 'room' AND COALESCE(b.hidden, 0) = 0";

function createGatewayChecks() {
  const listGateways = db.prepare(`SELECT b.id, ${gatewayUrl} AS gateway FROM bots b
    WHERE ${visibleAgents} AND gateway IS NOT NULL`);
  const getCurrent = db.prepare(`SELECT b.name, ${gatewayUrl} AS gateway, h.gateway_url, h.consecutive_failures
    FROM bots b LEFT JOIN agent_gateway_health h ON h.bot_id = b.id WHERE b.id = @id AND ${visibleAgents}`);
  const saveFailure = db.prepare(`INSERT INTO agent_gateway_health (bot_id, gateway_url, consecutive_failures)
    VALUES (?, ?, ?) ON CONFLICT(bot_id) DO UPDATE SET gateway_url = excluded.gateway_url,
      consecutive_failures = excluded.consecutive_failures`);
  const clearFailure = db.prepare('DELETE FROM agent_gateway_health WHERE bot_id = ?');
  const bumpUnread = db.prepare('UPDATE bots SET unread = unread + 1 WHERE id = ?');

  const record = db.transaction((id: string, gateway: string, ok: boolean) => {
    const current = getCurrent.get({ ...gatewaySettings, id }) as {
      name: string; gateway: string | null; gateway_url: string | null; consecutive_failures: number | null;
    } | undefined;
    // A deleted Bot or one whose connection changed during this probe needs no update.
    if (current?.gateway !== gateway) return;

    const wasDown = current.consecutive_failures === FAILURES_BEFORE_ALERT;
    let message: string;
    if (ok) {
      if (current.consecutive_failures === null) return;
      clearFailure.run(id);
      if (!wasDown) return;
      message = `${current.name} is back.`;
    } else {
      if (wasDown) return;
      const failures = current.gateway_url === gateway ? (current.consecutive_failures ?? 0) + 1 : 1;
      saveFailure.run(id, gateway, failures);
      if (failures < FAILURES_BEFORE_ALERT) return;
      message = `${current.name}'s gateway stopped answering at ${new Date().toISOString()}.`;
    }

    bumpUnread.run(id);
    return insertRow(id, 'message', { type: 'message', role: 'assistant', text: message });
  });

  return async () => {
    const bots = listGateways.all(gatewaySettings) as { id: string; gateway: string }[];
    const byGateway = new Map<string, string[]>();
    for (const { id, gateway } of bots) {
      const ids = byGateway.get(gateway) ?? [];
      ids.push(id);
      byGateway.set(gateway, ids);
    }

    const gateways = [...byGateway];
    for (let i = 0; i < gateways.length; i += MAX_CONCURRENT_PROBES) {
      const batch = gateways.slice(i, i + MAX_CONCURRENT_PROBES);
      const results = await Promise.allSettled(batch.map(async ([gateway, ids]) => {
        const ok = await isHermesHealthy(gateway);
        for (const id of ids) {
          const alert = record.immediate(id, gateway, ok);
          if (alert) {
            const { userId, row } = alert;
            hub.emit(userId, { type: 'rows', botId: id, generation: row.generation, rows: [row] });
            emitBot(id);
          }
        }
      }));
      for (const result of results) {
        if (result.status === 'rejected') console.error('[agent-health] Gateway check failed:', result.reason);
      }
    }
  };
}

export function startAgentGatewayMonitor() {
  const check = createGatewayChecks();
  async function pollAgentGateways() {
    try {
      await check();
    } catch (error) {
      console.error('[agent-health] Gateway check failed:', error);
    } finally {
      setTimeout(pollAgentGateways, CHECK_INTERVAL_MS).unref();
    }
  }
  void pollAgentGateways();
}
