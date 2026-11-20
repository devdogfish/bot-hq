import { useCallback, useEffect, useState } from 'react';
import type { Bot, EngineInfo } from '@shared/types';
import { configApi, type EnginePatch } from '../lib/configApi';
import { rememberProviders, saveEngineModels } from '../lib/engineModels';
import { useStore } from '../store';
import { AgentConnection } from './AgentConnection';
import { Icon } from './Icon';
import { ModelPicker, type ModelRef, type TriggerRender } from './ModelPicker';
import { OwnerSecretShares } from './OwnerSecretShares';

const STATUS: Record<EngineInfo['status'], string> = { ready: 'ready', starting: 'starting', stopped: 'stopped', error: 'error' };

/** The `mini-select` look, as a real button that opens the model menu. */
function pickerButton(text: string, title?: string): TriggerRender {
  return ({ toggle, ref, open: _open, ...aria }) => (
    <button ref={ref} type="button" className="mini-select mini-select--button engine__select" title={title} onClick={toggle} {...aria}>
      <span>{text}</span>
      <Icon name="chev_down" size={10} opacity={0.66} />
    </button>
  );
}

/**
 * Engine section of the details panel: the Agent's production model, the model used in direct chat, gateway status, and
 * (collapsed) the connection and shared items. Every call fails soft: if the engine endpoints are missing or down, the
 * section says so and the rest of the panel is unaffected.
 */
export function EngineSettings({ bot }: { bot: Bot }) {
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [busy, setBusy] = useState<'restart' | 'screen' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const botId = bot.id;

  const apply = useCallback((e: EngineInfo) => {
    setEngine(e); setPhase('ok');
    rememberProviders(e.botId, e.providers ?? []);
    // Keep the bot's model label in step (including the agent's default) without waiting for the server's `bot` event.
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === e.botId && (b.model !== e.model || b.provider !== e.provider) ? { ...b, model: e.model, provider: e.provider } : b)) }));
  }, []);

  /** Quiet refreshes keep what is on screen if the call fails. */
  const load = useCallback((quiet = false) => {
    let alive = true;
    if (!quiet) setPhase('loading');
    configApi.engine(botId)
      .then((r) => { if (alive && r?.engine) apply(r.engine); else if (alive && !quiet) setPhase('unavailable'); })
      .catch(() => { if (alive && !quiet) setPhase('unavailable'); });
    return () => { alive = false; };
  }, [botId, apply]);

  useEffect(() => { setEngine(null); setNote(null); return load(); }, [load]);

  // The agent takes a moment to come up after a change or a restart.
  const starting = engine?.status === 'starting';
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(() => load(true), 3000);
    return () => clearInterval(t);
  }, [starting, load]);

  const save = (patch: EnginePatch) => {
    setNote(null);
    saveEngineModels(botId, patch).then(apply).catch((e: Error) => setNote(`Couldn’t save: ${e.message || 'the engine did not answer'}`));
  };

  const restart = async () => {
    if (busy) return;
    setBusy('restart'); setNote(null);
    try { const r = await configApi.restartEngine(botId); apply(r.engine); }
    catch (e) { setNote(`Couldn’t restart: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const useThisScreen = async () => {
    if (busy) return;
    setBusy('screen'); setNote(null);
    try { const r = await configApi.stopOwnScreen(botId); apply(r.engine); }
    catch (e) { setNote(`Couldn’t switch screens: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const more = (
    <div className="panel-card engine__more">
      <AgentConnection key={`c-${botId}`} botId={botId} onSaved={() => load(true)} />
      <OwnerSecretShares key={`s-${botId}`} botId={botId} />
    </div>
  );

  if (phase !== 'ok' || !engine) {
    return (
      <>
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
        {more}
      </>
    );
  }

  const providers = engine.providers ?? [];
  const providerName = (id: string | null) => providers.find((p) => p.id === id)?.name ?? id ?? undefined;
  // The bot's own choice, else what the agent runs by default.
  const production: ModelRef = bot.model ? { provider: bot.provider, model: bot.model } : { provider: engine.provider, model: engine.model };
  const chat: ModelRef = { provider: bot.chatProvider, model: bot.chatModel };

  return (
    <>
      <div className="panel-card engine">
        <div className="panel-row panel-row--setting">
          <span>Production model</span>
          <ModelPicker
            label="Production model" providers={providers} value={production}
            onPick={(m) => save({ provider: m.provider, model: m.model })}
            trigger={pickerButton(production.model ?? 'Agent default', providerName(production.provider))}
          />
        </div>
        <div className="panel-row panel-row--setting">
          <span>Chat model</span>
          <ModelPicker
            label="Chat model" providers={providers} value={chat} production={production} defaultLabel="Same as production"
            onPick={(m) => save({ chatProvider: m.provider, chatModel: m.model })}
            actions={chat.model ? [{ label: 'Set as production model', onSelect: () => save({ provider: chat.provider, model: chat.model, chatProvider: null, chatModel: null }) }] : []}
            trigger={pickerButton(chat.model ?? 'Same as production', chat.model ? providerName(chat.provider) : undefined)}
          />
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
      {more}
    </>
  );
}
