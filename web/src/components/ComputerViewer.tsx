import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type RFBType from '@novnc/novnc';
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

const WATCH_GRACE_MS = 60_000;

type ScreenRegistration = NonNullable<ReturnType<typeof useStore.getState>['computer']>['screens'][number];
type Placement = { target: HTMLElement; native: boolean; dpr: number; pan: boolean };
type StreamFrame = {
  conn: Conn;
  clipped: boolean;
  snapshot: HTMLCanvasElement | null;
  size?: { width: number; height: number };
};
type StreamListener = (frame: StreamFrame) => void;

// noVNC 1.7 exposes clipping and scaling flags, but delegates pixel geometry and
// framebuffer presentation to its Display. Keep that version-specific integration here.
type NoVnc = RFBType & {
  dragViewport: boolean;
  clippingViewport: boolean;
  _screen: HTMLElement;
  _display: {
    _backbuffer: HTMLCanvasElement;
    width: number;
    height: number;
    absX(x: number): number;
    absY(y: number): number;
    flush(): Promise<void>;
  };
  _screenSize(): { w: number; h: number };
  _FBU: { width: number; height: number };
  _handleDataRect(): boolean;
  _framebufferUpdate(): boolean;
  _resize(width: number, height: number): void;
};

class ScreenStream {
  private readonly host = document.createElement('div');
  private rfb: NoVnc | null = null;
  private generation = 0;
  private painted = false;
  private handshaken = false;
  private conn: Conn = 'idle';
  private placement: Placement | null = null;
  private listener: StreamListener | null = null;

  constructor(
    private readonly entry: ScreenEntry,
    private readonly mode: ScreenMode,
  ) {
    Object.assign(this.host.style, { transformOrigin: 'top left', overflow: 'hidden' });
  }

  attach(placement: Placement, listener: StreamListener) {
    this.placement = placement;
    this.listener = listener;
    placement.target.append(this.host);
    this.layout(placement);
    this.publish();
  }

  layout(placement: Placement) {
    this.placement = placement;
    const { native, dpr, pan } = placement;
    this.host.style.width = this.host.style.height = `${dpr * 100}%`;
    this.host.style.transform = `scale(${1 / dpr})`;
    const rfb = this.rfb;
    if (!rfb) return;
    rfb.scaleViewport = !native;
    rfb.clipViewport = native;
    rfb.dragViewport = native && rfb.clippingViewport && (this.mode === 'watch' || pan);
  }

  detach(listener: StreamListener) {
    if (this.listener !== listener) return;
    this.capture();
    this.listener = null;
    this.placement = null;
    this.host.remove();
    if (this.rfb) {
      this.rfb.clipViewport = false;
      this.rfb.scaleViewport = false;
    }
  }

  start(retryFailed = false) {
    if (this.conn === 'idle' || (retryFailed && (this.conn === 'disconnected' || this.conn === 'error'))) {
      this.reconnect();
    }
  }

  focus() {
    this.rfb?.focus();
  }

  reconnect() {
    this.stop();
    const generation = this.generation;
    this.conn = 'connecting';
    this.publish();
    void import('@novnc/novnc').then(({ default: RFB }) => {
      if (generation !== this.generation) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/api/bots/${this.entry.botId}/screen?mode=${this.mode}`;
      const rfb = new RFB(this.host, url, { shared: true }) as NoVnc;
      this.rfb = rfb;
      rfb.qualityLevel = 8;
      rfb.compressionLevel = 2;
      rfb.viewOnly = this.mode === 'watch';
      rfb.resizeSession = false;
      rfb.background = 'transparent';
      rfb.focusOnClick = this.mode === 'control';

      // The host lays out in remote/device pixels and is transformed into CSS pixels.
      // noVNC's pointer events arrive in CSS pixels, so invert that transform for input.
      const display = rfb._display;
      const absX = display.absX.bind(display);
      const absY = display.absY.bind(display);
      display.absX = (x) => absX(x * (this.placement?.dpr ?? 1));
      display.absY = (y) => absY(y * (this.placement?.dpr ?? 1));
      rfb._screenSize = () => {
        const { clientWidth, clientHeight } = rfb._screen;
        if (this.placement?.native) return { w: clientWidth, h: clientHeight };
        return { w: Math.min(clientWidth, display.width), h: Math.min(clientHeight, display.height) };
      };

      // A protocol connection can precede the first image, especially for queued decoders.
      // Keep the snapshot visible until a decoded frame has populated the framebuffer.
      const resize = rfb._resize.bind(rfb);
      rfb._resize = (width, height) => {
        resize(width, height);
        if (this.painted) this.publish();
      };
      let hasPixels = false;
      const decode = rfb._handleDataRect.bind(rfb);
      rfb._handleDataRect = () => {
        const complete = decode();
        if (complete && rfb._FBU.width > 0 && rfb._FBU.height > 0) hasPixels = true;
        return complete;
      };
      const update = rfb._framebufferUpdate.bind(rfb);
      rfb._framebufferUpdate = () => {
        const complete = update();
        if (complete && hasPixels) {
          void display.flush().then(() => {
            if (this.rfb !== rfb || !this.handshaken || this.painted) return;
            rfb._handleDataRect = decode;
            rfb._framebufferUpdate = update;
            this.painted = true;
            this.capture();
            this.conn = 'connected';
            this.publish();
          }).catch(() => {});
          hasPixels = false;
        }
        return complete;
      };

      rfb.addEventListener('connect', () => {
        if (this.rfb !== rfb) return;
        this.handshaken = true;
      });
      rfb.addEventListener('clippingviewport', () => {
        if (this.rfb !== rfb) return;
        const placement = this.placement;
        rfb.dragViewport = rfb.clippingViewport && (this.mode === 'watch' || !!placement?.pan);
        this.publish();
      });
      rfb.addEventListener('disconnect', (event) => {
        if (this.rfb !== rfb) return;
        this.capture();
        this.handshaken = false;
        this.conn = (event as CustomEvent<{ clean: boolean }>).detail?.clean ? 'disconnected' : 'error';
        this.publish();
      });
      rfb.addEventListener('securityfailure', () => {
        if (this.rfb !== rfb) return;
        this.conn = 'error';
        this.publish();
      });
      if (this.placement) this.layout(this.placement);
    }).catch(() => {
      if (generation !== this.generation) return;
      this.conn = 'error';
      this.publish();
    });
  }

  stop() {
    this.capture();
    this.generation++;
    const rfb = this.rfb;
    this.rfb = null;
    this.painted = false;
    this.handshaken = false;
    this.conn = 'idle';
    rfb?.disconnect();
  }

  private capture() {
    const buffer = this.rfb?._display._backbuffer;
    if (!this.painted || !buffer?.width || !buffer.height) return;
    const snapshot = document.createElement('canvas');
    snapshot.width = buffer.width;
    snapshot.height = buffer.height;
    snapshot.getContext('2d')?.drawImage(buffer, 0, 0);
    this.entry.snapshot = snapshot;
  }

  private publish() {
    const buffer = this.rfb?._display._backbuffer;
    const image = this.painted && buffer?.width && buffer.height ? buffer : this.entry.snapshot;
    this.listener?.({
      conn: this.conn,
      clipped: !!this.rfb?.clippingViewport,
      snapshot: this.entry.snapshot,
      size: image ? { width: image.width, height: image.height } : undefined,
    });
  }
}

class ScreenEntry {
  readonly watch = new ScreenStream(this, 'watch');
  readonly control = new ScreenStream(this, 'control');
  snapshot: HTMLCanvasElement | null = null;
  timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly botId: string, readonly registration: ScreenRegistration) {}

  retain() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  release() {
    this.retain();
    this.timer = setTimeout(() => disposeScreen(this), WATCH_GRACE_MS);
  }
}

const screenEntries = new Map<string, ScreenEntry>();

function disposeScreen(entry: ScreenEntry) {
  entry.retain();
  entry.watch.stop();
  entry.control.stop();
  screenEntries.delete(entry.botId);
}

function getScreen(registration: ScreenRegistration) {
  const previous = screenEntries.get(registration.botId);
  if (previous?.registration.screenId === registration.screenId &&
      previous.registration.revision === registration.revision) return previous;
  const entry = new ScreenEntry(registration.botId, registration);
  if (previous) {
    disposeScreen(previous);
    entry.snapshot = previous.snapshot;
  }
  screenEntries.set(entry.botId, entry);
  return entry;
}

// Both viewer surfaces can be absent. Warm the signed-in selection independently of their mounts.
let selectedScreen: ScreenEntry | undefined;
function prewarmSelection(state: ReturnType<typeof useStore.getState>, previous?: ReturnType<typeof useStore.getState>) {
  if (state.user?.id !== previous?.user?.id) {
    for (const entry of screenEntries.values()) disposeScreen(entry);
    selectedScreen = undefined;
  }
  if (previous && state.user?.id === previous.user?.id &&
      state.selectedBotId === previous.selectedBotId && state.computer === previous.computer) return;
  const registration = state.user && state.computer?.screens.find((screen) => screen.botId === state.selectedBotId);
  const next = registration ? getScreen(registration) : undefined;
  if (selectedScreen === next) return;
  if (selectedScreen && screenEntries.get(selectedScreen.botId) === selectedScreen) selectedScreen.release();
  selectedScreen = next;
  next?.retain();
  next?.watch.start(true);
}
const stopPrewarming = useStore.subscribe(prewarmSelection);
prewarmSelection(useStore.getState());

import.meta.hot?.dispose(() => {
  stopPrewarming();
  for (const entry of screenEntries.values()) disposeScreen(entry);
});

/** A panel preview or native-pixel stage for the Agent computer. */
export function ComputerScreen({ bot, variant, initialMode = 'watch', hint, paused = false, onExpand, onModeChange }: ScreenProps) {
  const computer = useStore((s) => s.computer);
  const frameRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef<HTMLDivElement>(null);
  const activeStream = useRef<ScreenStream | null>(null);

  const [mode, setMode] = useState<ScreenMode>(initialMode);
  const [frame, setFrame] = useState<StreamFrame>({ conn: 'idle', clipped: false, snapshot: null });
  const [fullscreen, setFullscreen] = useState(false);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const [pan, setPan] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const screen = computer?.screens.find((s) => s.botId === bot.id);
  const { width, height } = frame.size ?? screenSize(computer, bot.id, bot.isPrimary);
  const driving = mode === 'control';
  const large = variant === 'stage' || fullscreen;
  const { conn, clipped, snapshot } = frame;
  const screenId = screen?.screenId;
  const screenRevision = screen?.revision;

  useEffect(() => {
    const on = () => setFullscreen(!!frameRef.current && document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const update = () => setDpr(window.devicePixelRatio || 1);
    query.addEventListener('change', update);
    window.addEventListener('resize', update);
    return () => {
      query.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, [dpr]);

  const placement = useRef<Placement | null>(null);
  useLayoutEffect(() => {
    const target = streamRef.current;
    if (!target) return;
    placement.current = { target, native: large, dpr, pan };
    activeStream.current?.layout(placement.current);
  }, [large, dpr, pan]);

  useLayoutEffect(() => {
    if (screenId === undefined || paused || !placement.current) return;
    const entry = getScreen({ botId: bot.id, screenId, revision: screenRevision });
    const stream = entry[mode];
    const update: StreamListener = setFrame;
    activeStream.current = stream;
    stream.attach(placement.current, update);
    stream.start(true);
    return () => {
      activeStream.current = null;
      stream.detach(update);
      if (mode === 'control') stream.stop();
    };
  }, [bot.id, screenId, screenRevision, mode, paused]);

  useLayoutEffect(() => {
    const host = snapshotRef.current;
    const view = viewRef.current;
    if (!snapshot || !host || !view) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'screen__cached-frame';
    canvas.width = snapshot.width;
    canvas.height = snapshot.height;
    canvas.getContext('2d')?.drawImage(snapshot, 0, 0);
    const size = () => {
      const scale = large ? 1 / dpr : Math.min(1 / dpr, view.clientWidth / canvas.width, view.clientHeight / canvas.height);
      const w = canvas.width * scale;
      const h = canvas.height * scale;
      Object.assign(canvas.style, {
        position: 'absolute', width: `${w}px`, height: `${h}px`,
        left: `${Math.max(0, (view.clientWidth - w) / 2)}px`, top: `${Math.max(0, (view.clientHeight - h) / 2)}px`,
      });
    };
    host.append(canvas);
    size();
    const observer = new ResizeObserver(size);
    observer.observe(view);
    return () => {
      observer.disconnect();
      canvas.remove();
    };
  }, [snapshot, dpr, large]);

  useEffect(() => {
    if (mode === 'control' && conn === 'connected') activeStream.current?.focus();
  }, [mode, conn]);

  useEffect(() => { onModeChange?.(mode); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handBack = useCallback(() => {
    setPan(false);
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
  else if (computer && !screen) phase = 'idle';
  else if (conn === 'error' || conn === 'disconnected') phase = 'error';
  else if (conn === 'connected') phase = 'live';
  else phase = snapshot ? 'switching' : 'waking';

  const takeControl = () => {
    if (variant === 'panel' && !fullscreen) onExpand?.('control');
    else setMode('control');
  };
  const retry = () => activeStream.current?.reconnect();
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else frameRef.current?.requestFullscreen().catch(() => setNote('Full screen isn’t available here.'));
  };
  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled;
  const expandable = variant === 'panel' && !fullscreen && phase === 'live';
  const mascot = large ? 64 : 40;
  const hasControls = driving || phase === 'live' || phase === 'switching';
  const panning = large && clipped && (!driving || pan);
  const style = {
    ...botVars(bot.avatarColor),
    '--screen-width': `${width / dpr}px`,
    '--screen-height': `${height / dpr}px`,
  } as CSSProperties;

  return (
    <div
      ref={frameRef}
      className={`screen screen--${variant} is-${phase}${driving ? ' is-driving' : ''}${fullscreen ? ' is-fullscreen' : ''}${hasControls ? ' has-controls' : ''}${panning ? ' is-panning' : ''}`}
      style={style}
    >
      <div className="screen__body">
        <div ref={viewRef} className="screen__view" style={large ? undefined : { aspectRatio: `${width} / ${height}` }}>
          <div className="screen__canvas">
            <div ref={streamRef} className="screen__stream" />
            <div ref={snapshotRef} className="screen__snapshot" aria-hidden />
          </div>
          {/* noVNC swallows clicks on its canvas, so the way into the large view is a button laid over it. */}
          {expandable && <button type="button" className="screen__expand" onClick={() => onExpand?.('watch')} aria-label={`Open ${bot.name}’s computer in the large view`} title="Open the large view" />}

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
            <span className="screen__note" role="status">Reconnecting…</span>
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

          {note && <span className="screen__note" role="status">{note}</span>}
        </div>

        {hasControls && (
          <div className={`screen__chin${driving ? '' : ' screen__chin--watch'}`}>
            <span className="screen__chin-text" role="status">
              <i className="screen__ping" aria-hidden />
              <span>{driving ? hint || 'You’re driving' : 'Agent has control'}</span>
            </span>
            <span className="screen__chin-actions">
              {driving && clipped && (
                <button type="button" className="screen__pan" aria-pressed={pan} onClick={() => setPan(!pan)}>
                  Pan screen
                </button>
              )}
              {canFullscreen && (
                <button type="button" className="screen__chin-icon" onClick={toggleFullscreen} aria-label={fullscreen ? 'Leave full screen' : 'Full screen'} title={fullscreen ? 'Leave full screen' : 'Full screen'}>
                  <Icon name={fullscreen ? 'shrink' : 'expand'} size={15} />
                </button>
              )}
              {driving ? (
                <button type="button" className="screen__handback" onClick={handBack}>
                  <BotAvatarFor bot={bot} size={18} />
                  <span>Hand back to {bot.name}</span>
                </button>
              ) : (
                <button type="button" className="screen__takeover" onClick={takeControl} aria-label="Take control">Take over</button>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** The large computer view: the bot's screen on a dimmed stage, opened from the chat menu or the details panel. */
export function ComputerViewer() {
  const bot = useSelectedBot();
  const computer = useStore((s) => s.computer);
  const initialMode = useStore((s) => s.viewerMode);
  const hint = useStore((s) => s.viewerHint);
  const set = useStore((s) => s.set);
  const [mode, setMode] = useState<ScreenMode>(initialMode);
  const botId = bot?.id;

  const close = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (mode === 'control' && botId) configApi.handback(botId).catch(() => {});
    set({ viewerOpen: false, viewerMode: 'watch', viewerHint: null });
  }, [mode, botId, set]);

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
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`${bot.name}’s computer`} style={botVars(bot.avatarColor)}>
      <div className="viewer__scrim" onClick={mode === 'watch' ? close : undefined} />
      <div className="viewer__top">
        <div className="viewer__title">
          <BotAvatarFor bot={bot} size={24} />
          <span>{bot.name}’s computer</span>
          <span className="viewer__status">{computer?.screens.some((screen) => screen.botId === bot.id) ? 'Screen configured' : 'No screen configured'}</span>
        </div>
        <button type="button" className="viewer__close" onClick={close} aria-label="Close computer"><Icon name="close" color="#FFFFFF" /></button>
      </div>
      <div className="viewer__stage">
        <ComputerScreen key={bot.id} bot={bot} variant="stage" initialMode={initialMode} hint={hint} onModeChange={onModeChange} />
      </div>
    </div>
  );
}
