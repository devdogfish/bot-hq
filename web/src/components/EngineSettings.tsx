import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot, EngineInfo, EngineProvider } from '@shared/types';
import { configApi } from '../lib/configApi';
import { useStore } from '../store';
import { AgentConnection } from './AgentConnection';
import { Icon } from './Icon';
import { OwnerSecretShares } from './OwnerSecretShares';

const KIND: Record<EngineProvider['kind'], string> = { subscription: 'Subscription', api_key: 'API key' };
const STATUS: Record<EngineInfo['status'], string> = { ready: 'ready', starting: 'starting', stopped: 'stopped', error: 'error' };

/** Connected providers first; otherwise the server's order. */
function sortProviders(list: EngineProvider[]): EngineProvider[] {
  return [...list].sort((a, b) => Number(b.connected) - Number(a.connected));
}

/**
 * Agent connection, provider, model and gateway status in the details panel. Every call fails soft: if the engine endpoints are missing or
 * down, the section says so and the rest of the panel is unaffected.
 */
export function EngineSettings({ bot }: { bot: Bot }) {
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState<'save' | 'restart' | 'screen' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const dirty = useRef(false);
  const botId = bot.id;

  const apply = useCallback((e: EngineInfo, keepDraft = false) => {
    setEngine(e); setPhase('ok');
    if (!keepDraft || !dirty.current) { dirty.current = false; setProvider(e.provider ?? ''); setModel(e.model ?? ''); }
    // Keep the bot's model label in step without waiting for the server's `bot` event.
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === e.botId && (b.model !== e.model || b.provider !== e.provider) ? { ...b, model: e.model, provider: e.provider } : b)) }));
  }, []);

  /** Quiet refreshes keep what is on screen if the call fails. */
  const load = useCallback((quiet = false) => {
    let alive = true;
    if (!quiet) setPhase('loading');
    configApi.engine(botId)
      .then((r) => { if (alive && r?.engine) apply(r.engine, quiet); else if (alive && !quiet) setPhase('unavailable'); })
      .catch(() => { if (alive && !quiet) setPhase('unavailable'); });
    return () => { alive = false; };
  }, [botId, apply]);

  useEffect(() => { dirty.current = false; setEngine(null); setNote(null); return load(); }, [load]);

  // The agent takes a moment to come up after a change or a restart.
  const starting = engine?.status === 'starting';
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(() => load(true), 3000);
    return () => clearInterval(t);
  }, [starting, load]);

  const connection = <AgentConnection key={botId} botId={botId} onSaved={() => load(true)} />;
  if (phase !== 'ok' || !engine) {
    return (
      <>
        {connection}
        <OwnerSecretShares key={botId} botId={botId} />
      <div className="panel-card">
        <div className="panel-empty engine__empty">
          {phase === 'loading' ? 'Checking…' : (
            <>
              <span>Engine unavailable</span>
              <button type="button" className="link-btn link-btn--small" onClick={() => load()}>Try again</button>
            </>
          )}
        </div>
      </div>
      </>
    );
  }

  const providers = sortProviders(engine.providers ?? []);
  const selected = providers.find((p) => p.id === provider) ?? null;
  const suggestions = selected?.models ?? [];
  const wantProvider = provider && provider !== (engine.provider ?? '') ? provider : undefined;
  const wantModel = model.trim() && model.trim() !== (engine.model ?? '') ? model.trim() : undefined;
  const changed = !!wantProvider || !!wantModel;
  const listId = `engine-models-${botId}`;

  const pickProvider = (id: string) => {
    dirty.current = true; setNote(null); setProvider(id);
    const next = providers.find((p) => p.id === id);
    // A model from another provider will not work here, so start from this provider's first suggestion.
    if (next?.models.length && !next.models.includes(model.trim())) setModel(next.models[0]);
  };

  const save = async () => {
    if (!changed || busy) return;
    setBusy('save'); setNote(null);
    try { const r = await configApi.setEngine(botId, { ...(wantProvider ? { provider: wantProvider } : {}), ...(wantModel ? { model: wantModel } : {}) }); dirty.current = false; apply(r.engine); }
    catch (e) { setNote(`Couldn’t save: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const restart = async () => {
    if (busy) return;
    setBusy('restart'); setNote(null);
    try { const r = await configApi.restartEngine(botId); apply(r.engine, true); }
    catch (e) { setNote(`Couldn’t restart: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const useThisScreen = async () => {
    if (busy) return;
    setBusy('screen'); setNote(null);
    try { const r = await configApi.stopOwnScreen(botId); apply(r.engine, true); }
    catch (e) { setNote(`Couldn’t switch screens: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  return (
    <>
      {connection}
      <OwnerSecretShares key={botId} botId={botId} />
      <div className="panel-card engine">
        <div className="panel-row panel-row--setting">
          <span>Provider</span>
          <span className="mini-select mini-select--native engine__select">
            <span>{selected?.name ?? (provider || 'Default')}</span>
            <Icon name="chev_down" size={10} opacity={0.66} />
            <select aria-label="Provider" value={provider} onChange={(e) => pickProvider(e.target.value)}>
              {!selected && <option value={provider}>{provider || 'Default'}</option>}
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {KIND[p.kind]} · {p.connected ? 'Connected' : 'Not connected'}</option>)}
            </select>
          </span>
        </div>
        {selected && (
          <div className={`engine__conn${selected.connected ? ' is-on' : ''}`}>
            <i aria-hidden />
            <span>{selected.connected ? 'Connected' : 'Not connected'} · {KIND[selected.kind]}</span>
          </div>
        )}
        <div className="panel-row panel-row--setting">
          <label htmlFor={`${listId}-input`}>Model</label>
          <input
            id={`${listId}-input`} className="engine__model" list={listId} value={model} spellCheck={false} autoComplete="off"
            placeholder={suggestions[0] ?? 'Model id'}
            onChange={(e) => { dirty.current = true; setNote(null); setModel(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          />
          <datalist id={listId}>{suggestions.map((m) => <option key={m} value={m} />)}</datalist>
        </div>
        <div className="engine__actions">
          <button type="button" className="btn btn--sm btn--bot" onClick={save} disabled={!changed || busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          {changed && <button type="button" className="link-btn link-btn--small" onClick={() => { dirty.current = false; setNote(null); setProvider(engine.provider ?? ''); setModel(engine.model ?? ''); }}>Undo</button>}
        </div>
        {engine.ownScreen && (
          <div className="engine__notice">
            <span>{bot.name} also has a private screen of its own switched on. Desktop work it does there (clicking around apps) will not show on the screen here.</span>
            <button type="button" className="link-btn link-btn--small" onClick={useThisScreen} disabled={busy === 'screen'}>{busy === 'screen' ? 'Switching…' : 'Use this screen'}</button>
          </div>
        )}
        {note && <div className="voice-error" role="alert">{note}</div>}
        <div className="engine__meta">
          <span className={`engine__state is-${engine.status}`} title={engine.version ? `Hermes ${engine.version}` : undefined}>
            <i aria-hidden />
            Hermes · {engine.kind === 'remote' ? 'remote Agent' : engine.kind ? engine.profile : 'unregistered'} · {STATUS[engine.status]}
          </span>
          {engine.kind === 'managed' && (engine.status === 'error' || engine.status === 'stopped') && (
            <button type="button" className="link-btn link-btn--small" onClick={restart} disabled={busy === 'restart'}>{busy === 'restart' ? 'Restarting…' : 'Restart agent'}</button>
          )}
        </div>
        {engine.status === 'error' && engine.error && <div className="engine__error">{engine.error}</div>}
      </div>
    </>
  );
}
