import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Minimize2, Volume2, VolumeX } from 'lucide-react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { botVars } from '../lib/colors';
import { useStore } from '../store';
import { callLevels, endCall, toggleMute, toggleSpeaker, useVoice } from '../voice/call';

function HangUpGlyph() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden>
      <path fill="currentColor" d="M12 9.5c-2.6 0-5.1.5-7.3 1.6-.7.3-1.2 1-1.2 1.8v2.3c0 .8.7 1.4 1.5 1.3l3-.4c.7-.1 1.2-.7 1.2-1.4v-1.6c1.8-.5 3.8-.5 5.6 0v1.6c0 .7.5 1.3 1.2 1.4l3 .4c.8.1 1.5-.5 1.5-1.3v-2.3c0-.8-.5-1.5-1.2-1.8-2.2-1.1-4.7-1.6-7.3-1.6Z" />
    </svg>
  );
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * The in-call UI, copied from the references. Expanded: a dark card across the top of the chat with the
 * Agent's avatar, name and timer over speaker, hang-up and mic. Minimised: a small card in the chat's
 * top-left corner (avatar, name, timer; mic and hang-up as two equal pills). Shown while a call is
 * connecting, live, or just failed.
 */
export function VoiceCallBar() {
  const v = useVoice();
  const bot = useStore((s) => s.bots.find((b) => b.id === v.botId));
  const [now, setNow] = useState(Date.now());
  const [mini, setMini] = useState(false);
  const avatarRef = useRef<HTMLSpanElement>(null);
  const active = v.status === 'connecting' || v.status === 'live';

  useEffect(() => {
    if (v.status !== 'live') return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [v.status]);
  // Each new call opens expanded.
  useEffect(() => { if (v.status === 'connecting') setMini(false); }, [v.status]);

  // The avatar pulses with the Agent's voice, driven from the output level without re-rendering React.
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let out = 0;
    const tick = () => {
      out = out * 0.7 + callLevels().out * 0.3;
      avatarRef.current?.style.setProperty('--out', out.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  if (v.status === 'idle' || v.status === 'ending' || !bot) return null;

  const sub =
    v.status === 'connecting' ? 'Connecting…'
    : v.status === 'error' ? v.error ?? 'Call ended'
    : v.startedAt ? fmt(now - v.startedAt) : '0:00';
  const dismiss = () => useVoice.setState({ status: 'idle', botId: null, error: null });
  const mic = (
    <button type="button" className={`vcard__btn${v.muted ? ' is-on' : ''}`} onClick={toggleMute} aria-pressed={v.muted} aria-label={v.muted ? 'Unmute' : 'Mute'} title={v.muted ? 'Unmute' : 'Mute'}>
      {v.muted ? <MicOff size={15} strokeWidth={2} aria-hidden /> : <Mic size={15} strokeWidth={2} aria-hidden />}
    </button>
  );
  const end = (
    <button type="button" className="vcard__btn vcard__btn--end" onClick={endCall} aria-label="End call" title="End call">
      <HangUpGlyph />
    </button>
  );

  if (mini) {
    return (
      <div className={`vcard is-mini is-${v.status}`} style={botVars(bot.avatarColor)} role="region" aria-label={`Voice call with ${bot.name}`}>
        <button type="button" className="vcard__who" onClick={() => setMini(false)} title="Expand call" aria-label="Expand call">
          <span className="vcard__avatar" ref={avatarRef}><BotAvatarFor bot={bot} size={31} /></span>
          <span className="vcard__text">
            <span className="vcard__name">{firstName(bot.name)}</span>
            <span className="vcard__sub" aria-live="polite">{sub}</span>
          </span>
        </button>
        <div className="vcard__actions">
          {active ? <>{mic}{end}</> : <button type="button" className="vcard__btn" onClick={dismiss}>Dismiss</button>}
        </div>
      </div>
    );
  }

  return (
    <div className={`vcard is-full is-${v.status}`} style={botVars(bot.avatarColor)} role="region" aria-label={`Voice call with ${bot.name}`}>
      {active && (
        <button type="button" className="vcard__min" onClick={() => setMini(true)} aria-label="Minimise call" title="Minimise call">
          <Minimize2 size={14} strokeWidth={2} aria-hidden />
        </button>
      )}
      <span className="vcard__avatar vcard__avatar--lg" ref={avatarRef}><BotAvatarFor bot={bot} size={48} /></span>
      <span className="vcard__name">{firstName(bot.name)}</span>
      <span className="vcard__sub" aria-live="polite">{sub}</span>
      <div className="vcard__actions">
        {active ? (
          <>
            <button type="button" className={`vcard__btn${v.speakerOff ? ' is-on' : ''}`} onClick={toggleSpeaker} aria-pressed={v.speakerOff} aria-label={v.speakerOff ? 'Turn speaker on' : 'Turn speaker off'} title={v.speakerOff ? 'Turn speaker on' : 'Turn speaker off'}>
              {v.speakerOff ? <VolumeX size={16} strokeWidth={2} aria-hidden /> : <Volume2 size={16} strokeWidth={2} aria-hidden />}
            </button>
            {end}
            {mic}
          </>
        ) : <button type="button" className="vcard__btn" onClick={dismiss}>Dismiss</button>}
      </div>
    </div>
  );
}

const firstName = (name: string) => name.split(/[\s·]+/)[0] || name;
