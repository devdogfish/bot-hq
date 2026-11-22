import { useMemo, useRef, useState } from 'react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { displayName, sortedRows, useSelectedBot, useStore } from '../store';
import { useConfigUI } from '../configStore';
import { Composer } from './Composer';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { StepsHistory, Transcript } from './Transcript';
import { isWaitingForYou } from '../lib/phrases';
import { VoiceCallBar } from './VoiceCallBar';

/** The Alfred header shows only the first name: "James", not "James Diaz · Personal Assistant". */
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

export function ChatView() {
  const bot = useSelectedBot();
  const transcript = useStore((s) => (bot ? s.transcripts[bot.id] : undefined));
  const live = useStore((s) => (bot ? s.live[bot.id] : undefined));
  const pendingPause = useStore((s) => (bot ? s.pendingPause[bot.id] : undefined));
  const setBotPaused = useStore((s) => s.setBotPaused);
  const detailsOpen = useStore((s) => s.detailsOpen);
  const set = useStore((s) => s.set);
  const [menu, setMenu] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
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
  const waiting = isWaitingForYou(live);
  const working = !!live?.isRunning && !waiting;
  // Alfred-style header: the Agent's name with a quieter live line under it.
  const headerStatus = waiting ? 'Needs you' : working ? 'Thinking...' : pauseStatus;
  const hasSteps = rows.some((r) => r.body.type === 'tool-call');
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
      <Transcript bot={bot} rows={rows} loaded={!!transcript?.loaded} />
      <VoiceCallBar />
      <Composer key={bot.id} bot={bot} running={!!live?.isRunning} pausePending={pendingPause !== undefined} />
      <header className="chat__header">
        <span className="chat__pill-anchor">
          <button ref={menuButton} type="button" className={`chat__pill${working ? ' is-working' : ''}${waiting ? ' is-waiting' : ''}`} onClick={() => { setStepsOpen(false); setMenu(!menu); }} aria-haspopup="menu" aria-expanded={menu} aria-label={displayName(bot)}>
            <BotAvatarFor bot={bot} size={36} />
            <span className="chat__pill-text">
              <span className="chat__pill-name">{firstName(bot.name)}</span>
              <span className="chat__pill-status" role="status" aria-live="polite">{bot.kind === 'room' && !working && !waiting ? '' : headerStatus}</span>
            </span>
          </button>
          {menu && (
            <Menu
              align="center"
              onClose={() => setMenu(false)}
              items={[
                ...(hasSteps || working ? [{ label: 'Show steps', onSelect: () => setStepsOpen(true) }] : []),
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
          {stepsOpen && (
            <Menu align="center" onClose={() => setStepsOpen(false)} items={[]}>
              <div className="steps-popover" aria-label="Steps">
                <StepsHistory rows={rows} live={live} />
              </div>
            </Menu>
          )}
        </span>
        <div className="chat__header-right">
          {!detailsOpen && (
            <button type="button" className="icon-btn icon-btn--bordered" onClick={() => set({ detailsOpen: true })} aria-label="Show details" title="Show details">
              <Icon name="sidebar" opacity={0.66} style={{ transform: 'scaleX(-1)' }} />
            </button>
          )}
          <button type="button" className="share-btn" onClick={() => flash('Sharing isn’t available in Bot HQ yet')}>Share</button>
        </div>
      </header>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
