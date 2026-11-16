import { useMemo, useRef, useState } from 'react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { displayName, sortedRows, useSelectedBot, useStore } from '../store';
import { useConfigUI } from '../configStore';
import { Composer } from './Composer';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { Transcript } from './Transcript';
import { VoiceCallBar } from './VoiceCallBar';

export function ChatView() {
  const bot = useSelectedBot();
  const transcript = useStore((s) => (bot ? s.transcripts[bot.id] : undefined));
  const live = useStore((s) => (bot ? s.live[bot.id] : undefined));
  const pendingPause = useStore((s) => (bot ? s.pendingPause[bot.id] : undefined));
  const setBotPaused = useStore((s) => s.setBotPaused);
  const detailsOpen = useStore((s) => s.detailsOpen);
  const set = useStore((s) => s.set);
  const [menu, setMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [toast, setToast] = useState<string | null>(null);
  const rows = useMemo(() => sortedRows(transcript), [transcript]);

  if (!bot) {
    return (
      <main className="chat chat--empty">
        <div className="empty-chat"><div className="empty-chat__sub">No Bot selected.</div></div>
      </main>
    );
  }

  const flash = (text: string) => {
    setToast(text);
    setTimeout(() => setToast((current) => current === text ? null : current), 2000);
  };
  const pauseStatus = pendingPause === undefined ? (bot.paused ? 'Paused' : '') : pendingPause ? 'Pausing…' : 'Resuming…';
  const togglePause = () => {
    const paused = !bot.paused;
    menuButton.current?.focus();
    setToast(null);
    setBotPaused(bot.id, paused).catch((error: Error) => {
      flash(`Couldn’t ${paused ? 'pause' : 'resume'} ${bot.name}. ${error.message}`);
    });
  };

  return (
    <main className="chat" style={botVars(bot.avatarColor)}>
      <Transcript bot={bot} rows={rows} live={live} loaded={!!transcript?.loaded} />
      <VoiceCallBar />
      <Composer key={bot.id} bot={bot} running={!!live?.isRunning} pausePending={pendingPause !== undefined} />
      <header className="chat__header">
        <span className="chat__pill-anchor">
          <button ref={menuButton} type="button" className="chat__pill" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
            <BotAvatarFor bot={bot} size={24} />
            <span className="chat__pill-name">{displayName(bot)}</span>
            {bot.kind !== 'room' && <span className="chat__pill-status" role="status">{pauseStatus}</span>}
          </button>
          {menu && (
            <Menu
              align="center"
              onClose={() => setMenu(false)}
              items={[
                { label: detailsOpen ? 'Hide details' : 'Show details', hint: '⇧⌘,', onSelect: () => set({ detailsOpen: !detailsOpen }) },
                { label: 'Open computer', onSelect: () => set({ viewerOpen: true, viewerMode: 'watch', viewerHint: null }) },
                { label: 'New conversation', onSelect: () => api.fresh(bot.id).then(() => flash('Started a new conversation')).catch((e) => flash(e.message)) },
                ...(bot.kind === 'room' ? [] : [{
                  label: bot.paused ? 'Resume bot' : 'Pause bot',
                  onSelect: togglePause,
                  disabled: pendingPause !== undefined,
                }]),
                { label: 'Bot settings', onSelect: () => useConfigUI.getState().openBotSettings(bot.id) },
              ]}
            />
          )}
        </span>
        <div className="chat__header-right">
          {!detailsOpen && (
            <button type="button" className="icon-btn icon-btn--bordered" onClick={() => set({ detailsOpen: true })} aria-label="Show details" title="Show details">
              <Icon name="sidebar" opacity={0.66} style={{ transform: 'scaleX(-1)' }} />
            </button>
          )}
          <button type="button" className="share-btn" onClick={() => flash('Sharing isn’t available in Grokbot yet')}>Share</button>
        </div>
      </header>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
