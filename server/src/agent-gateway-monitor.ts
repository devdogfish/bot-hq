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

interface GatewayBot {
  id: string;
  gateway: string;
  gateway_revision: number;
}

function createGatewayChecks() {
  const listGateways = db.prepare(`SELECT b.id, ${gatewayUrl} AS gateway, b.gateway_revision FROM bots b
    WHERE ${visibleAgents} AND gateway IS NOT NULL`);
  const getCurrent = db.prepare(`SELECT b.name, ${gatewayUrl} AS gateway, b.gateway_revision,
      h.gateway_url, h.consecutive_failures
    FROM bots b LEFT JOIN agent_gateway_health h ON h.bot_id = b.id WHERE b.id = @id AND ${visibleAgents}`);
  const saveFailure = db.prepare(`INSERT INTO agent_gateway_health (bot_id, gateway_url, consecutive_failures)
    VALUES (?, ?, ?) ON CONFLICT(bot_id) DO UPDATE SET gateway_url = excluded.gateway_url,
      consecutive_failures = excluded.consecutive_failures`);
  const clearFailure = db.prepare('DELETE FROM agent_gateway_health WHERE bot_id = ?');
  const bumpUnread = db.prepare('UPDATE bots SET unread = unread + 1 WHERE id = ?');

  const record = db.transaction(({ id, gateway, gateway_revision }: GatewayBot, ok: boolean) => {
    const current = getCurrent.get({ ...gatewaySettings, id }) as {
      name: string; gateway: string | null; gateway_revision: number;
      gateway_url: string | null; consecutive_failures: number | null;
    } | undefined;
    // The revision also catches changes away from this URL and back during the probe.
    if (current?.gateway !== gateway || current.gateway_revision !== gateway_revision) return;

    const failures = current.gateway_url === gateway ? current.consecutive_failures ?? 0 : 0;
    const wasDown = failures >= FAILURES_BEFORE_ALERT;
    let message: string;
    if (ok) {
      if (current.consecutive_failures === null) return;
      clearFailure.run(id);
      if (!wasDown) return;
      message = `${current.name} is back.`;
    } else {
      if (wasDown) return;
      saveFailure.run(id, gateway, failures + 1);
      if (failures + 1 < FAILURES_BEFORE_ALERT) return;
      message = `${current.name}'s gateway stopped answering at ${new Date().toISOString()}.`;
    }

    bumpUnread.run(id);
    return insertRow(id, 'event', { type: 'event', event: 'gateway-health', text: message });
  });

  async function probeGateway(gateway: string, bots: GatewayBot[]) {
    const ok = await isHermesHealthy(gateway);
    for (const bot of bots) {
      try {
        const alert = record.immediate(bot, ok);
        if (alert) {
          const { userId, row } = alert;
          hub.emit(userId, { type: 'rows', botId: bot.id, generation: row.generation, rows: [row] });
          emitBot(bot.id);
        }
      } catch (error) {
        console.error('[agent-health] Could not record gateway health for Bot %s:', bot.id, error);
      }
    }
  }

  return async () => {
    const bots = listGateways.all(gatewaySettings) as GatewayBot[];
    const byGateway = new Map<string, GatewayBot[]>();
    for (const bot of bots) {
      const gateway = (URL.parse(bot.gateway)?.href ?? bot.gateway).replace(/\/+$/, '');
      const group = byGateway.get(gateway) ?? [];
      group.push(bot);
      byGateway.set(gateway, group);
    }

    const pending = byGateway.entries();
    async function worker() {
      for (const [gateway, group] of pending) {
        try {
          await probeGateway(gateway, group);
        } catch (error) {
          console.error('[agent-health] Gateway probe failed:', error);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(byGateway.size, MAX_CONCURRENT_PROBES) }, worker));
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
