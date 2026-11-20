import { useEffect, useState } from 'react';
import type { Bot, VoiceOption } from '@shared/types';
import { useStore } from '../store';
import { voiceApi, type VoiceOptions } from '../voice/api';
import { endCall, isCallActive, previewVoice, startCall, useVoice } from '../voice/call';
import { Icon } from './Icon';
import { MiniSelect } from './MiniSelect';

type ProviderId = 'xai' | 'elevenlabs';
type VoiceBot = Bot & { voiceProvider?: ProviderId };
type SettingsOptions = Pick<VoiceOptions, 'languages' | 'speeds'> & {
  providers?: { id: ProviderId; name: string; available: boolean }[];
  voices: VoiceOption[] | Partial<Record<ProviderId, VoiceOption[]>>;
};

const optionsApi: {
  options: () => Promise<SettingsOptions>;
  providerOptions?: () => Promise<SettingsOptions>;
} = voiceApi;

const KNOWN_PROVIDERS: ProviderId[] = ['xai', 'elevenlabs'];
/** An API without providers only speaks xAI. */
const XAI_ONLY = [{ id: 'xai', name: 'xAI', available: true }] as const;
const KEY_HINT: Record<ProviderId, string> = { xai: 'Add XAI_API_KEY', elevenlabs: 'Add ELEVENLABS_API_KEY' };
const FALLBACK: SettingsOptions = {
  voices: ['ara', 'eve', 'leo', 'luna', 'rex', 'sal'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })),
  languages: [{ code: 'auto', name: 'Auto-detect' }, { code: 'en', name: 'English' }],
  speeds: [0.7, 0.85, 1, 1.15, 1.3, 1.5],
};

const speedLabel = (s: number) => `${Number(s.toFixed(2))}x`;

/** "Voice chat" section of the details panel: voice, speed, language (saved per bot), preview, start a call. */
export function VoiceSettings({ bot }: { bot: VoiceBot }) {
  const [opts, setOpts] = useState<SettingsOptions>(FALLBACK);
  const [changingVoice, setChangingVoice] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);

  useEffect(() => { (optionsApi.providerOptions ?? optionsApi.options)().then(setOpts).catch(() => {}); }, []);
  useEffect(() => setError(null), [bot.id]);

  const updateBot = (patch: Partial<Pick<VoiceBot, 'voice' | 'voiceSpeed' | 'voiceLanguage' | 'voiceProvider'>>) => {
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, ...patch } : b)) }));
  };

  const save = async (patch: Partial<Pick<Bot, 'voice' | 'voiceSpeed' | 'voiceLanguage'>>, nextProvider?: ProviderId) => {
    const changesVoice = patch.voice !== undefined || nextProvider !== undefined;
    if (changesVoice && changingVoice) return;
    if (changesVoice) setChangingVoice(true);
    const prev = useStore.getState().bots.find((b) => b.id === bot.id);
    if (!nextProvider) updateBot(patch);
    setError(null);
    try {
      const res = await fetch(`/api/bots/${bot.id}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...patch, voice_provider: nextProvider }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (nextProvider) {
        // Preview resolves the provider from the saved bot, so use the confirmed pair.
        const { bot: saved } = await res.json() as { bot: VoiceBot };
        if (saved.voiceProvider !== nextProvider) throw new Error('Provider change was not saved');
        updateBot({ voiceProvider: saved.voiceProvider, voice: saved.voice });
      }
    } catch {
      if (prev && !nextProvider) updateBot({
        ...(patch.voice !== undefined && { voice: prev.voice }),
        ...(patch.voiceSpeed !== undefined && { voiceSpeed: prev.voiceSpeed }),
        ...(patch.voiceLanguage !== undefined && { voiceLanguage: prev.voiceLanguage }),
      });
      setError('Couldn’t save that setting.');
    } finally {
      if (changesVoice) setChangingVoice(false);
    }
  };

  const preview = async () => {
    if (previewing || changingVoice) return;
    setPreviewing(true); setError(null);
    try { await previewVoice({ botId: bot.id, voice: bot.voice, speed: bot.voiceSpeed, language: bot.voiceLanguage }); }
    catch (e) { setError((e as Error).message || 'Preview unavailable'); }
    finally { setPreviewing(false); }
  };

  // The server's providers in a fixed order; unknown ids are ignored.
  const listed = opts.providers ? KNOWN_PROVIDERS.flatMap((id) => opts.providers?.filter((p) => p.id === id) ?? []) : [...XAI_ONLY];
  const providers = listed.length ? listed : [...XAI_ONLY];
  const provider = providers.find((p) => p.id === (bot.voiceProvider ?? 'xai')) ?? providers[0];
  const pickProvider = (id: ProviderId) => {
    const choices = providerVoices(id);
    const voice = (id === 'xai' ? choices.find((v) => v.id === 'luna') : undefined) ?? choices[0];
    void save({ voice: voice?.id }, id);
  };
  const providerVoices = (id: ProviderId) => Array.isArray(opts.voices) ? (id === 'xai' ? opts.voices : []) : opts.voices[id] ?? [];
  const catalog = providerVoices(provider.id);
  const voices = catalog.some((v) => v.id === bot.voice) ? catalog : [{ id: bot.voice, name: bot.voice }, ...catalog];
  const speeds = opts.speeds.includes(bot.voiceSpeed) ? opts.speeds : [...opts.speeds, bot.voiceSpeed].sort((a, b) => a - b);

  return (
    <div className="panel-card">
      <div className="panel-row panel-row--setting">
        <span>Provider</span>
        <MiniSelect label="Provider" value={provider.id} disabled={changingVoice} onChange={pickProvider}
          options={providers.map((p) => ({ value: p.id, label: p.name, disabled: !p.available, hint: p.available ? undefined : KEY_HINT[p.id] }))} />
      </div>
      <div className="panel-row panel-row--setting">
        <span>Voice</span>
        <fieldset className="voice-setting__right" disabled={changingVoice || !provider.available}>
          <button type="button" className="voice-preview" onClick={preview} disabled={previewing} title={`Hear ${bot.name}'s voice`}>{previewing ? 'Playing…' : 'Preview'}</button>
          <MiniSelect label="Voice" value={bot.voice} options={voices.map((v) => ({ value: v.id, label: v.name }))} onChange={(voice) => save({ voice })} />
        </fieldset>
      </div>
      <div className="panel-row panel-row--setting">
        <span>Speed</span>
        <MiniSelect label="Speed" value={bot.voiceSpeed} options={speeds.map((s) => ({ value: s, label: speedLabel(s) }))} onChange={(voiceSpeed) => save({ voiceSpeed })} />
      </div>
      <div className="panel-row panel-row--setting">
        <span>Language</span>
        <MiniSelect label="Language" value={bot.voiceLanguage} options={opts.languages.map((l) => ({ value: l.code, label: l.name }))} onChange={(voiceLanguage) => save({ voiceLanguage })} />
      </div>
      <button type="button" className={`panel-row panel-row--action panel-row--call${inCall ? ' is-active' : ''}`} disabled={(changingVoice || !provider.available) && !inCall} onClick={() => (inCall ? endCall() : startCall(bot.id))}>
        <Icon name="voice_a" size={14} opacity={inCall ? 1 : 0.56} /> {inCall ? 'End voice chat' : 'Start voice chat'}
      </button>
      {error && <div className="voice-error">{error}</div>}
    </div>
  );
}
