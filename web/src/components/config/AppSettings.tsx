import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi } from '../../lib/configApi';
import { useConfigUI, type AppSection, type Theme } from '../../configStore';
import { isArchived, useStore } from '../../store';
import { Icon } from '../Icon';
import { Glyph } from './glyphs';
import { Play } from 'lucide-react';
import { previewSoundSet, SOUND_SET_OPTIONS } from '../../lib/sounds';

const SECTIONS: { id: AppSection; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'computer', label: 'Computer' },
  { id: 'account', label: 'Account' },
  { id: 'archived', label: 'Archived' },
];

/** Full-window settings page, opened from the account menu. */
export function AppSettings() {
  const section = useConfigUI((s) => s.appSettings);
  const close = useConfigUI((s) => s.closeAppSettings);
  const open = useConfigUI((s) => s.openAppSettings);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-root')) { e.preventDefault(); close(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [close]);
  if (!section) return null;
  return createPortal(
    <div className="app-settings" role="dialog" aria-modal="true" aria-label="Settings">
      <aside className="app-settings__nav">
        <button type="button" className="app-settings__back" onClick={close}><Glyph name="arrow_left" size={14} /> Back to Bots</button>
        <div className="app-settings__heading">Settings</div>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className={`cfg-nav__item${section === s.id ? ' is-active' : ''}`} onClick={() => open(s.id)} aria-current={section === s.id || undefined}>
            {s.label}
          </button>
        ))}
      </aside>
      <div className="app-settings__main">
        <button type="button" className="app-settings__close icon-btn" onClick={close} aria-label="Close settings" title="Close (Esc)"><Icon name="close" opacity={0.8} /></button>
        <div className="app-settings__page">
          {section === 'general' && <GeneralSection />}
          {section === 'computer' && <ComputerSection />}
          {section === 'account' && <AccountSection />}
          {section === 'archived' && <ArchivedSection />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PageHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="app-settings__head">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ThemeTile({ value, label, current, onPick }: { value: Theme; label: string; current: Theme; onPick: (t: Theme) => void }) {
  return (
    <button type="button" role="radio" aria-checked={current === value} className={`theme-tile${current === value ? ' is-active' : ''}`} onClick={() => onPick(value)}>
      <span className={`theme-tile__art is-${value}`} aria-hidden>
        <span className="theme-tile__side" />
        <span className="theme-tile__pane"><i /><i /><b /></span>
      </span>
      <span className="theme-tile__label">{label}</span>
    </button>
  );
}

function GeneralSection() {
  const theme = useConfigUI((s) => s.theme);
  const setTheme = useConfigUI((s) => s.setTheme);
  return (
    <>
      <PageHead title="General" />
      <section className="cfg-section">
        <div className="cfg-section__label">Theme</div>
        <div className="theme-tiles" role="radiogroup" aria-label="Theme">
          <ThemeTile value="system" label="System" current={theme} onPick={setTheme} />
          <ThemeTile value="light" label="Light" current={theme} onPick={setTheme} />
          <ThemeTile value="dark" label="Dark" current={theme} onPick={setTheme} />
        </div>
        <div className="cfg-field__hint">System follows your device’s light or dark setting.</div>
      </section>
      <SoundsSection />
    </>
  );
}

/** Sound set for send, receive and reactions. Saved to the Owner's account. */
function SoundsSection() {
  const current = useStore((s) => s.user?.soundSet ?? 'hollow_bubble');
  const setSoundSet = useStore((s) => s.setSoundSet);
  const [error, setError] = useState<string | null>(null);
  const pick = (id: typeof current) => {
    setError(null);
    setSoundSet(id).catch((e: Error) => setError(`Couldn’t save the sound choice. ${e.message}`));
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Sounds</div>
      {error && <div className="cfg-error" role="alert">{error}</div>}
      <div className="cfg-card sound-sets" role="radiogroup" aria-label="Sounds">
        {SOUND_SET_OPTIONS.map((o) => (
          <div key={o.id} className={`cfg-row sound-set${current === o.id ? ' is-active' : ''}`}>
            <button type="button" role="radio" aria-checked={current === o.id} className="sound-set__pick" onClick={() => pick(o.id)}>
              <span className="sound-set__radio" aria-hidden />
              <span className="sound-set__label">{o.label}</span>
              <span className="sound-set__hint">{o.hint}</span>
            </button>
            {o.id !== 'none' && (
              <button type="button" className="sound-set__play icon-btn icon-btn--plain" onClick={() => previewSoundSet(o.id)} aria-label={`Play ${o.label}`} title="Play">
                <Play size={14} strokeWidth={2} aria-hidden />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="cfg-field__hint">Sounds play only while Bot HQ is on screen, and never with Reduce motion on.</div>
      <div className="cfg-field__hint">Sounds: <a href="https://notificationsounds.com/" target="_blank" rel="noreferrer noopener">notificationsounds.com</a> (Hollow, Accomplished; CC BY 4.0) and Pixabay.</div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function ComputerSection() {
  const computer = useStore((s) => s.computer);
  const bots = useStore((s) => s.bots);
  const pendingArchive = useStore((s) => s.pendingArchive);
  const registered = new Set(computer?.screens.map((screen) => screen.botId));
  return (
    <>
      <PageHead title="Agent screens" sub="Register each screen in the bot’s Agent connection settings." />
      <div className="cfg-card">
        {bots.filter((bot) => bot.kind !== 'room' && !isArchived(bot, pendingArchive)).map((bot) => (
          <div className="cfg-row" key={bot.id}>
            <BotAvatarFor bot={bot} size={28} />
            <div className="cfg-row__text">
              <div className="cfg-row__title">{bot.name}</div>
              <div className="cfg-row__sub">{!computer ? 'Checking…' : registered.has(bot.id) ? 'Screen configured' : 'No screen configured'}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ArchivedSection() {
  const bots = useStore((s) => s.bots);
  const pending = useStore((s) => s.pendingArchive);
  const archiveError = useStore((s) => s.archiveError);
  const setArchived = useStore((s) => s.setBotArchived);
  const entries = bots.filter((bot) => isArchived(bot, pending) || pending[bot.id] === false);
  return (
    <>
      <PageHead title="Archived" />
      {archiveError && <div className="cfg-error" role="alert">{archiveError}</div>}
      {entries.length === 0 ? <p>No archived Bots.</p> : (
        <div className="cfg-card">
          {entries.map((bot) => {
            const archived = isArchived(bot, pending);
            const action = archived ? 'Unarchive' : 'Undo unarchive';
            return (
              <div className="cfg-row" key={bot.id}>
                <BotAvatarFor bot={bot} size={28} />
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{bot.name}</div>
                </div>
                <button type="button" className="cfg-btn cfg-btn--secondary" aria-label={`${action} ${bot.name}`} onClick={() => void setArchived(bot.id, !archived)}>
                  {action}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function AccountSection() {
  const user = useStore((s) => s.user);
  const [busy, setBusy] = useState(false);
  const initials = (user?.name ?? user?.email ?? '?').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <>
      <PageHead title="Account" />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <span className="account__initials">{initials}</span>
            <div className="cfg-row__text">
              <div className="cfg-row__title">{user?.name}</div>
              <div className="cfg-row__sub">{user?.email}</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={async () => { setBusy(true); await configApi.logout().catch(() => {}); location.reload(); }}>
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
