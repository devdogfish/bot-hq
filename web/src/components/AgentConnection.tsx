import { useEffect, useState } from 'react';
import { configApi, type AgentSettings } from '../lib/configApi';

export function AgentConnection({ botId, onSaved }: { botId: string; onSaved: () => void }) {
  const [agent, setAgent] = useState<AgentSettings | null>(null);
  const [hermesKey, setHermesKey] = useState('');
  const [vncPassword, setVncPassword] = useState('');
  const [ownerSecretToken, setOwnerSecretToken] = useState('');
  const [ownerSecretPort, setOwnerSecretPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    configApi.agent(botId).then(({ agent }) => {
      if (active) {
        setAgent(agent);
        setOwnerSecretPort(String(agent.ownerSecretPort));
      }
    }).catch((err: Error) => {
      if (active) setNote({ text: err.message, error: true });
    });
    return () => { active = false; };
  }, [botId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!agent || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const { agent: next } = await configApi.setAgent(botId, {
        ...agent, hermesKey, vncPassword, ownerSecretPort: Number(ownerSecretPort), ownerSecretToken,
      });
      setAgent(next);
      setHermesKey('');
      setVncPassword('');
      setOwnerSecretToken('');
      setNote({ text: 'Saved.' });
      onSaved();
    } catch (err) {
      setNote({ text: (err as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  async function checkChrome() {
    setBusy(true);
    setNote(null);
    try {
      const { browser } = await configApi.checkChrome(botId);
      setNote({ text: `Reached ${browser}.` });
    } catch (err) {
      setNote({ text: (err as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="panel-card">
      <summary className="panel-row">Agent connection</summary>
      {agent ? (
        <form onSubmit={save}>
          <fieldset className="panel-empty agent-connection" disabled={busy} aria-busy={busy}>
            <label>Hermes API URL
              <input type="url" className="text-input" value={agent.hermesUrl} placeholder="http://agent:8642"
                onChange={(e) => setAgent({ ...agent, hermesUrl: e.target.value })} />
            </label>
            <label>Hermes API key
              <input type="password" className="text-input" autoComplete="new-password" value={hermesKey}
                placeholder={agent.hermesKeySet ? 'Saved · enter a new key to replace' : undefined}
                onChange={(e) => setHermesKey(e.target.value)} />
            </label>
            <label>Owner secret port
              <input type="number" className="text-input" min={1} max={65535} required value={ownerSecretPort}
                onChange={(e) => setOwnerSecretPort(e.target.value)} />
            </label>
            <label>Owner secret token
              <input type="password" className="text-input" autoComplete="new-password" value={ownerSecretToken}
                placeholder={agent.ownerSecretTokenSet ? 'Saved · enter a new token to replace' : undefined}
                onChange={(e) => setOwnerSecretToken(e.target.value)} />
            </label>
            <label>Websockify URL
              <input type="url" className="text-input" value={agent.websockifyUrl} placeholder="ws://agent:6080/websockify"
                onChange={(e) => setAgent({ ...agent, websockifyUrl: e.target.value })} />
            </label>
            <label>VNC password
              <input type="password" className="text-input" autoComplete="new-password" maxLength={8} value={vncPassword}
                placeholder={agent.vncPasswordSet ? 'Saved · enter a new password to replace' : undefined}
                onChange={(e) => setVncPassword(e.target.value)} />
            </label>
            <label>Chrome DevTools port
              <input type="number" className="text-input" min={1} max={65535} value={agent.cdpPort ?? ''}
                onChange={(e) => setAgent({ ...agent, cdpPort: e.target.value ? Number(e.target.value) : null })} />
            </label>
            <div className="engine__actions">
              <button className="btn btn--sm btn--bot" type="submit">Save connection</button>
              <button className="btn btn--sm btn--secondary" type="button" onClick={checkChrome}>Check Chrome</button>
            </div>
            <a className="link-btn" href={`/api/bots/${botId}/agent/mcp?format=yaml`} target="_blank" rel="noreferrer">MCP settings</a>
          </fieldset>
        </form>
      ) : !note && <div className="panel-empty">Loading…</div>}
      {note && <div className="panel-empty" role={note.error ? 'alert' : 'status'}>{note.text}</div>}
    </details>
  );
}
