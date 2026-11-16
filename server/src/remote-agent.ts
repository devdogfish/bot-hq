import { z } from 'zod';
import { db } from './db.js';

interface RemoteAgentRow {
  hermes_url: string | null;
  hermes_key: string | null;
  websockify_url: string | null;
  vnc_password: string | null;
  cdp_port: number | null;
}

function endpoint(protocols: string[], allowPath: boolean) {
  return z.string().trim().max(2048).transform((value, ctx) => {
    if (!value) return null;
    const url = URL.parse(value);
    if (!url || !protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      (!allowPath && url.pathname !== '/')) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid URL without credentials, query or fragment.' });
      return z.NEVER;
    }
    return allowPath ? url.href : url.origin;
  });
}

const settingsSchema = z.object({
  hermesUrl: endpoint(['http:', 'https:'], false),
  hermesKey: z.string().trim().max(4096).regex(/^[!-~]*$/, 'Enter a valid Hermes API key.').optional(),
  websockifyUrl: endpoint(['ws:', 'wss:'], true),
  vncPassword: z.string().regex(/^[\x20-\x7e]{0,8}$/, 'Use a VNC password of up to 8 ASCII characters.').optional(),
  cdpPort: z.number().int().min(1).max(65535).nullable(),
});

export function remoteAgentSettings(row: RemoteAgentRow) {
  return {
    hermesUrl: row.hermes_url ?? '',
    hermesKeySet: !!row.hermes_key,
    websockifyUrl: row.websockify_url ?? '',
    vncPasswordSet: !!row.vnc_password,
    cdpPort: row.cdp_port,
  };
}

export function saveRemoteAgent(botId: string, current: RemoteAgentRow, input: unknown) {
  const result = settingsSchema.safeParse(input);
  if (!result.success) return result.error.issues.map((issue) => issue.message).join(' ');
  const { hermesUrl, websockifyUrl, cdpPort } = result.data;
  const hermesKey = hermesUrl && (result.data.hermesKey || (hermesUrl === current.hermes_url && current.hermes_key));
  const vncPassword = websockifyUrl && (result.data.vncPassword || (websockifyUrl === current.websockify_url && current.vnc_password));
  if (hermesUrl && !hermesKey) return 'Enter the API key for this Hermes URL.';
  if (websockifyUrl && !vncPassword) return 'Enter the password for this VNC screen.';
  if (cdpPort !== null && !websockifyUrl) return 'Enter a websockify URL to identify the Chrome host.';
  const changedScreen = websockifyUrl !== current.websockify_url || (vncPassword || null) !== current.vnc_password;
  db.prepare(`UPDATE bots SET hermes_url=?, hermes_key=?, websockify_url=?, vnc_password=?, cdp_port=?,
    screen_revision=screen_revision+? WHERE id=?`)
    .run(hermesUrl, hermesKey || null, websockifyUrl, vncPassword || null, cdpPort, Number(changedScreen), botId);
  return null;
}

/** Chrome and websockify run on the same Agent. Keep discovery on the registered host. */
export function chromeUrl(row: RemoteAgentRow): URL | null {
  if (!row.websockify_url || !row.cdp_port) return null;
  const url = new URL(row.websockify_url);
  url.protocol = 'http:';
  url.port = String(row.cdp_port);
  return new URL('/json/version', url);
}
