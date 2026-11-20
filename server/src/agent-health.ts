import { isIPv4 } from 'node:net';
import { Hono } from 'hono';
import { isHermesHealthy } from './hermes-health.js';

function parseTargets(setting: string) {
  const targets = new Map<string, string>();
  if (!setting.trim()) return targets;

  for (const entry of setting.split(',')) {
    const [name, ip, extra] = entry.trim().split('=');
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || !ip || extra !== undefined ||
        !isIPv4(ip) || !ip.startsWith('100.') || Number(ip.split('.')[1]) < 64 ||
        Number(ip.split('.')[1]) > 127 || targets.has(name)) {
      throw new Error('Invalid HQ_AGENT_HEALTH_TARGETS entry');
    }
    targets.set(name, `http://${ip}:8642`);
  }
  return targets;
}

export function agentHealthRoutes(setting: string) {
  const targets = parseTargets(setting);
  const routes = new Hono();
  routes.get('/:agent', async (c) => {
    c.header('Cache-Control', 'no-store');
    const origin = targets.get(c.req.param('agent'));
    if (!origin) return c.json({ ok: false }, 404);

    const ok = await isHermesHealthy(origin);
    return c.json({ ok }, ok ? 200 : 503);
  });
  return routes;
}
