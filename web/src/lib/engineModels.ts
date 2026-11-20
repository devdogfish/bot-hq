import { useEffect, useState } from 'react';
import type { EngineProvider } from '@shared/types';
import { useStore } from '../store';
import { configApi, type EnginePatch } from './configApi';

/** Providers per bot, so the composer's model menu opens without waiting when the details panel already loaded them. */
const providersByBot = new Map<string, EngineProvider[]>();

export function rememberProviders(botId: string, providers: EngineProvider[]) {
  providersByBot.set(botId, providers);
}

/** Loads the provider list the first time `enabled` turns on (the menu opens); later opens reuse it and refresh quietly. */
export function useProviders(botId: string, enabled: boolean) {
  const [providers, setProviders] = useState<EngineProvider[] | null>(() => providersByBot.get(botId) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setProviders(providersByBot.get(botId) ?? null); setFailed(false); }, [botId]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setFailed(false);
    configApi.engine(botId)
      .then(({ engine }) => { if (!alive) return; rememberProviders(botId, engine.providers ?? []); setProviders(engine.providers ?? []); })
      .catch(() => { if (alive && !providersByBot.has(botId)) setFailed(true); });
    return () => { alive = false; };
  }, [botId, enabled]);
  return { providers, failed };
}

const FIELDS = ['provider', 'model', 'chatProvider', 'chatModel'] as const;

/**
 * Saves model choices optimistically: the bot's labels change at once, the server's `bot` event confirms. On failure only
 * the fields that still show this attempt go back, so a later pick made while this one was saving is kept.
 */
export async function saveEngineModels(botId: string, patch: EnginePatch) {
  const before = useStore.getState().bots.find((b) => b.id === botId);
  const fields = FIELDS.filter((k) => patch[k] !== undefined);
  useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === botId ? { ...b, ...Object.fromEntries(fields.map((k) => [k, patch[k] ?? null])) } : b)) }));
  try {
    const { engine } = await configApi.setEngine(botId, patch);
    rememberProviders(botId, engine.providers ?? []);
    return engine;
  } catch (e) {
    if (before) {
      useStore.setState((s) => ({
        bots: s.bots.map((b) => {
          if (b.id !== botId) return b;
          const back = fields.filter((k) => b[k] === (patch[k] ?? null));
          return back.length ? { ...b, ...Object.fromEntries(back.map((k) => [k, before[k]])) } : b;
        }),
      }));
    }
    throw e;
  }
}
