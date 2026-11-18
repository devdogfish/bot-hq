import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { botVars } from '../lib/colors';
import { screenSize } from '../lib/computer';
import { configApi } from '../lib/configApi';
import { useSelectedBot, useStore } from '../store';
import { Icon } from './Icon';

export type ScreenMode = 'watch' | 'control';
type Conn = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';
type Phase = 'live' | 'switching' | 'waking' | 'idle' | 'paused' | 'error';

interface ScreenProps {
  bot: Bot;
  /** 'panel' is the small live view in the details panel; 'stage' is the large view. */
  variant: 'panel' | 'stage';
  initialMode?: ScreenMode;
  /** Replaces "You're driving" under the frame, e.g. a sign-in the person has to finish. */
  hint?: string | null;
  /** Stop streaming and show a placeholder (the large view has this screen). */
  paused?: boolean;
  /** Panel only: the person asked for the large view, in this mode. */
  onExpand?: (mode: ScreenMode) => void;
  onModeChange?: (mode: ScreenMode) => void;
}

/**
 * A bot's screen on its Agent machine: noVNC over our relay inside a rounded frame that keeps the
 * screen's aspect ratio. Watching is view-only. Taking control reconnects with mode=control and shows
 * a chin under the frame with the way back.
 */
export function ComputerScreen({ bot, variant, initialMode = 'watch', hint, paused = false, onExpand, onModeChange }: ScreenProps) {
  const computer = useStore((s) => s.computer);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const hadFrame = useRef(false);

  const [mode, setMode] = useState<ScreenMode>(initialMode);
  const [conn, setConn] = useState<Conn>('idle');
  const [attempt, setAttempt] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const [framebuffer, setFramebuffer] = useState<{ width: number; height: number }>();
  const [note, setNote] = useState<string | null>(null);

  const screen = computer?.screens.find((s) => s.botId === bot.id);
  const hasScreen = !!screen;
  const { width, height } = framebuffer ?? screenSize(computer, bot.id, bot.isPrimary);
  const driving = mode === 'control';
  const large = variant === 'stage' || fullscreen;
  const wantLive = hasScreen && !paused && visible;

  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  useEffect(() => {
    const on = () => setFullscreen(!!frameRef.current && document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  useEffect(() => {
    if (!wantLive || !canvasRef.current) { setConn('idle'); return; }
    let disposed = false;
    let rfb: import('@novnc/novnc').default | undefined;
    let framebufferObserver: MutationObserver | undefined;
    setConn('connecting');
    (async () => {
      const { default: RFB } = await import('@novnc/novnc');
      if (disposed || !canvasRef.current) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/api/bots/${bot.id}/screen?mode=${mode}`;
      rfb = new RFB(canvasRef.current, url, { shared: true });
      rfb.viewOnly = mode === 'watch';
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = 'transparent';
      rfb.focusOnClick = mode === 'control';
      // noVNC's canvas backing dimensions track RFB desktop resizes as well as ServerInit.
      const canvas = canvasRef.current.querySelector('canvas');
      const readFramebuffer = () => {
        if (!canvas?.width || !canvas.height) return;
        const { width, height } = canvas;
        setFramebuffer((previous) => previous?.width === width && previous.height === height ? previous : { width, height });
      };
      rfb.addEventListener('connect', () => {
        if (disposed) return;
        readFramebuffer();
        if (canvas) {
          framebufferObserver = new MutationObserver(readFramebuffer);
          framebufferObserver.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
        }
        hadFrame.current = true;
        setConn('connected');
        if (mode === 'control') rfb?.focus();
      });
      rfb.addEventListener('disconnect', (e) => { if (!disposed) setConn((e as CustomEvent<{ clean: boolean }>).detail?.clean ? 'disconnected' : 'error'); });
      rfb.addEventListener('securityfailure', () => { if (!disposed) setConn('error'); });
    })().catch(() => { if (!disposed) setConn('error'); });
    const el = canvasRef.current;
    return () => {
      disposed = true;
      try { rfb?.disconnect(); } catch { /* already closed */ }
      framebufferObserver?.disconnect();
      el.innerHTML = '';
    };
  }, [bot.id, wantLive, mode, attempt, screen?.revision]);

  useEffect(() => { onModeChange?.(mode); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handBack = useCallback(() => {
    setConn('connecting');
    setMode('watch');
    // The bot carries on either way; this only tells it sooner.
    configApi.handback(bot.id).catch(() => {});
  }, [bot.id]);

  // The panel view is too small to drive: control there only exists in full screen, and ends with it.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    if (variant === 'panel' && !fullscreen && modeRef.current === 'control') handBack();
  }, [variant, fullscreen, handBack]);

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(timer);
  }, [note]);

  let phase: Phase;
  if (paused) phase = 'paused';
  else if (computer && !hasScreen) phase = 'idle';
  else if (conn === 'error' || conn === 'disconnected') phase = 'error';
  else if (conn === 'connected') phase = 'live';
  else phase = hadFrame.current ? 'switching' : 'waking';

  const takeControl = () => {
    if (variant === 'panel' && !fullscreen) onExpand?.('control');
    else {
      setConn('connecting');
      setMode('control');
    }
  };
  const retry = () => {
    setAttempt((n) => n + 1);
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else frameRef.current?.requestFullscreen().catch(() => setNote('Full screen isn’t available here.'));
  };
  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled;
  const canTakeControl = phase === 'live' && !driving;
  const mascot = large ? 64 : 40;
  const style = { ...botVars(bot.avatarColor), ['--screen-ratio' as string]: String(width / height) } as CSSProperties;

  return (
    <div
      ref={frameRef}
      className={`screen screen--${variant} is-${phase}${driving ? ' is-driving' : ''}${fullscreen ? ' is-fullscreen' : ''}`}
      style={style}
    >
      <div className="screen__body">
        <div className="screen__view" style={{ aspectRatio: `${width} / ${height}` }}>
          <div ref={canvasRef} className="screen__canvas" />
          {canTakeControl && (
            <button type="button" className="screen__takeover" onClick={takeControl} aria-label={`Take control of ${bot.name}’s computer`} />
          )}

          {phase === 'live' && !driving && (
            <span className="screen__badge" aria-hidden>
              <BotAvatarFor bot={bot} size={16} />
              <span>Live</span>
              <i className="screen__live-dot" />
            </span>
          )}

          {phase === 'waking' && (
            <div className="screen__state is-waking" role="status">
              <span className="screen__sweep" aria-hidden />
              <span className="screen__mascot is-bobbing"><BotAvatarFor bot={bot} size={mascot} /></span>
              <span className="screen__label">Connecting to {bot.name}’s screen…</span>
            </div>
          )}
          {phase === 'switching' && (
            <div className="screen__state" role="status">
              <span className="screen__text">One moment…</span>
            </div>
          )}
          {phase === 'idle' && (
            <div className="screen__state">
              <span className="screen__mascot"><BotAvatarFor bot={bot} size={mascot} /></span>
              <span className="screen__text">Register a screen in Agent connection settings</span>
            </div>
          )}
          {phase === 'paused' && (
            <div className="screen__state">
              <span className="screen__text">Open in the large view</span>
            </div>
          )}
          {phase === 'error' && (
            <div className="screen__state" role="alert">
              <span className="screen__text">
                {conn === 'disconnected' ? 'The screen disconnected' : `Couldn’t reach ${bot.name}’s screen`}
              </span>
              <button type="button" className="screen__action" onClick={retry}>Retry</button>
            </div>
          )}

          {phase === 'live' && !driving && !large && (
            <div className={`screen__pill${note ? ' is-pinned' : ''}`} role="toolbar" aria-label="Screen controls">
              {note && <span className="screen__pill-text" role="status">{note}</span>}
              <div className="screen__seg" role="group" aria-label="Who is using the screen">
                <button type="button" className="screen__seg-btn" onClick={() => onExpand?.('watch')}>Open</button>
                <button type="button" className="screen__seg-btn" aria-pressed="false" onClick={takeControl}>Take control</button>
              </div>
              {canFullscreen && (
                <>
                  <span className="screen__pill-rule" aria-hidden />
                  <button type="button" className="screen__pill-icon" onClick={toggleFullscreen} aria-label="Full screen" title="Full screen">
                    <Icon name="expand" size={15} />
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {(driving || large) && (
          <div className="screen__chin">
            <span className="screen__chin-text" role="status">
              {driving && phase === 'live' && <i className="screen__ping" aria-hidden />}
              <span>{note || (phase === 'live' ? driving ? hint || 'You have control' : 'Watching' : '')}</span>
            </span>
            <span className="screen__chin-actions">
              {canFullscreen && (
                <button type="button" className="screen__chin-icon" onClick={toggleFullscreen} aria-label={fullscreen ? 'Leave full screen' : 'Full screen'} title={fullscreen ? 'Leave full screen' : 'Full screen'}>
                  <Icon name={fullscreen ? 'shrink' : 'expand'} size={15} />
                </button>
              )}
              {driving ? (
                <button type="button" className="screen__handback" onClick={handBack}>Return control</button>
              ) : (
                <button type="button" className="screen__handback" onClick={takeControl} disabled={!canTakeControl}>Take control</button>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** The full-size computer pane, opened from the chat menu or the details panel. */
export function ComputerViewer() {
  const bot = useSelectedBot();
  const initialMode = useStore((s) => s.viewerMode);
  const hint = useStore((s) => s.viewerHint);
  const set = useStore((s) => s.set);
  const [mode, setMode] = useState<ScreenMode>(initialMode);
  const botId = bot?.id;
  const currentMode = useRef(mode);
  currentMode.current = mode;
  useEffect(() => () => {
    if (currentMode.current === 'control' && botId) configApi.handback(botId).catch(() => {});
  }, [botId]);

  const close = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    set({ viewerOpen: false, viewerMode: 'watch', viewerHint: null });
  }, [set]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // While driving, Escape belongs to the remote desktop. In full screen the browser uses it to leave.
      if (e.key === 'Escape' && mode === 'watch' && !document.fullscreenElement) { e.preventDefault(); close(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [mode, close]);

  const onModeChange = useCallback((m: ScreenMode) => {
    setMode(m);
    // A hint belongs to one stretch of driving; it goes once the person hands back.
    set(m === 'watch' ? { viewerMode: m, viewerHint: null } : { viewerMode: m });
  }, [set]);

  if (!bot) return null;

  return (
    <aside className="viewer" aria-label={`${bot.name}’s computer`} style={botVars(bot.avatarColor)}>
      <div className="viewer__top">
        <div className="viewer__title">
          <BotAvatarFor bot={bot} size={24} />
          <span>{bot.name}’s computer</span>
        </div>
        <button type="button" className="viewer__close" onClick={close} aria-label="Close computer"><Icon name="close" /></button>
      </div>
      <div className="viewer__stage">
        <ComputerScreen key={bot.id} bot={bot} variant="stage" initialMode={initialMode} hint={hint} onModeChange={onModeChange} />
      </div>
    </aside>
  );
}
