import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const hermesHome = process.env.HERMES_HOME_PRIMARY ?? process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes');

const dataDir = process.env.HQ_DATA_DIR ?? fileURLToPath(new URL('../../data', import.meta.url));
const jitsiOrigins = (process.env.HQ_JITSI_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
const meetingOwnerNames = (process.env.HQ_MEETING_OWNER_NAMES ?? '').split(',').map((name) => name.trim()).filter(Boolean);

export const env = {
  host: process.env.HQ_HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 8787),
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  xaiKey: process.env.XAI_API_KEY ?? '',
  elevenlabsKey: process.env.ELEVENLABS_API_KEY ?? '',
  elevenlabsAgentId: process.env.ELEVENLABS_AGENT_ID ?? '',
  xaiModel: process.env.XAI_MODEL ?? 'grok-4.7',
  /** Jitsi origins whose "Add people" dialog may list and invite Agents (comma-separated, e.g. https://meet.example.com). Empty disables it. */
  jitsiOrigins,
  meetingOwnerNames: meetingOwnerNames.length ? meetingOwnerNames : ['Owner'],
  sessionSecret: req('SESSION_SECRET'),
  devLogin: process.env.DEV_LOGIN === '1',
  dbPath: process.env.DB_PATH ?? path.join(dataDir, 'grokbot.db'),

  // ---- Hermes engine ----
  /** The `hermes` CLI used to start a gateway for each extra bot. */
  hermesBin: process.env.HERMES_BIN ?? 'hermes',
  /** The primary bot's Hermes home and API server (an agent that already runs; never restarted by us). */
  hermesHome,
  hermesUrl: (process.env.HERMES_URL ?? 'http://127.0.0.1:8642').replace(/\/+$/, ''),
  hermesKey: process.env.HERMES_KEY ?? '',
  /** Where each extra bot's own Hermes home lives. Must be outside ~/.hermes so it is a separate tenant. */
  enginesDir: process.env.ENGINES_DIR ?? path.join(dataDir, 'engines'),
  libraryDir: path.resolve(process.env.HQ_LIBRARY_DIR ?? path.join(dataDir, 'files')),
  localEngines: process.env.HQ_LOCAL_ENGINES === '1',
  enginePortBase: Number(process.env.ENGINE_PORT_BASE ?? 8650),
  agentHealthTargets: process.env.HQ_AGENT_HEALTH_TARGETS ?? '',
  /** URL the Hermes gateways use to reach this server's MCP endpoint. */
  mcpBaseUrl: (process.env.MCP_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`).replace(/\/+$/, ''),
  /** Extra MCP servers every managed bot gets, as a JSON object of Hermes `mcp_servers` entries (e.g. X's XMCP). */
  extraMcpServers: process.env.EXTRA_MCP_SERVERS ?? '',
  primaryBotName: process.env.PRIMARY_BOT_NAME ?? 'Doug',
  primaryBotLabel: process.env.PRIMARY_BOT_LABEL ?? 'Chief of Staff',

  /** Comma-separated emails allowed to sign in; empty = anyone who can reach the app. */
  allowedEmails: (process.env.ALLOWED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};
