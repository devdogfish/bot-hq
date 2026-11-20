import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { env } from './env.js';
import { api } from './routes.js';
import { attachVncRelay } from './vnc.js';
import { initRoutines } from './routines.js';
import { initProactive } from './proactive.js';
import { initSubagents } from './agent/subagents.js';
import { initRooms } from './agent/rooms.js';
import { checkinsApi } from './routes-proactive.js';
import { roomsApi } from './routes-rooms.js';
import { enqueue, expireStaleApprovals, isBotBusy } from './agent/loop.js';
import { desSelfTest } from './lib/des.js';
import { configApi } from './routes-config.js';
import { secureInputApi } from './routes-secure-input.js';
import { mcpApi } from './mcp.js';
import { meetingApi } from './meeting/routes.js';
import { jitsiInviteApi } from './jitsi-invite.js';
import { closeInterruptedMeetings } from './voice/index.js';
import { hooksApi } from './routes-hooks.js';
import { enqueueEvent, resumeEventRoutines } from './events.js';
import { initEngines } from './engine.js';
import { agentHealthRoutes } from './agent-health.js';
import { startAgentGatewayMonitor } from './agent-gateway-monitor.js';
import { gmailPushConfig, startGmailPush } from './gmail-push/index.js';

if (!desSelfTest()) throw new Error('DES self-test failed');
initSubagents();
initRooms();
// Approvals wait in memory; whatever was still open when the last process stopped can no longer be answered.
expireStaleApprovals();
closeInterruptedMeetings();

const app = new Hono();
app.get('/api/health', (c) => c.json({ ok: true, engine: 'hermes' }));
app.route('/api/agent-health', agentHealthRoutes(env.agentHealthTargets));
// The app's tools for the agent engines (MCP).
app.route('/mcp', mcpApi);
app.route('/api/meeting', meetingApi);
app.route('/api/jitsi', jitsiInviteApi);
app.route('/hooks', hooksApi);
app.route('/api/checkins', checkinsApi);
app.route('/api/rooms', roomsApi);
app.route('/api', secureInputApi);
app.route('/api', api);
app.route('/api', configApi);
app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

// Serve the built web app in production.
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (fs.existsSync(webDist)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) }));
  app.get('*', (c) => c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')));
}

const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => console.log(`[grokbot] server on http://localhost:${info.port}`));
attachVncRelay(server as unknown as Server);
// GROKBOT_NO_SCHEDULER=1 for extra dev/test servers sharing a database copy.
const schedulerEnabled = process.env.GROKBOT_NO_SCHEDULER !== '1';
if (schedulerEnabled) {
  initRoutines(enqueue, isBotBusy);
  initProactive(enqueue);
  const gmailPush = gmailPushConfig();
  if (gmailPush) {
    const worker = startGmailPush(gmailPush, enqueueEvent).catch(() => {
      console.error('[gmail-push] Could not start the Pub/Sub worker.');
    });
    server.once('close', () => {
      void worker.then(stop => stop?.()).catch(() => console.error('[gmail-push] Could not close the Pub/Sub worker.'));
    });
  }
} else console.log('[grokbot] scheduler disabled (GROKBOT_NO_SCHEDULER=1)');
initEngines();
// Recover accepted webhook work even when periodic scheduling is disabled.
resumeEventRoutines();
if (schedulerEnabled) startAgentGatewayMonitor();
