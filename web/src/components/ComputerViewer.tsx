import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type RFBType from '@novnc/novnc';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { botVars } from '../lib/colors';
import { screenSize } from '../lib/computer';
import { configApi } from '../lib/configApi';
import { useSelectedBot, useStore } from '../store';
import { Icon } from './Icon';
import { isMacPlatform, MAC_KEYBOARD_LOCK_CODES, pasteChord, readCmdAsCtrl, releaseHeld, translateKeyDown, translateKeyUp, writeCmdAsCtrl, type KeyStroke } from './computer-keys';

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
  /** Show a placeholder while the large view has this screen. */
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
const EMPTY_FRAME: StreamFrame = { conn: 'idle', clipped: false, snapshot: null };

function pixelGrid(dpr: number) {
  // Compositors can snap the clipping layer to CSS pixels before scaling it.
  // Use the nearest grid shared by CSS and device pixels at common zoom levels.
  for (let step = 1; step <= 20; step++) {
    const pixels = step * dpr;
    if (Math.abs(pixels - Math.round(pixels)) < 0.001) return step;
  }
  return 1 / dpr;
}

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
    viewportChangePos(x: number, y: number): void;
    flush(): Promise<void>;
  };
  _screenSize(): { w: number; h: number };
  _FBU: { width: number; height: number };
  _keyboard: { _keyDownList: Record<string, number> } | null;
  sendKey(keysym: number, code: string, down?: boolean): void;
  clipboardPasteFrom(text: string): void;
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
  /** Text the Agent copied while the Owner drives; control streams only. */
  onClipboard: ((text: string) => void) | null = null;

  constructor(
    private readonly entry: ScreenEntry,
    private readonly mode: ScreenMode,
  ) {
    Object.assign(this.host.style, { transformOrigin: 'top left', overflow: 'hidden' });
  }

  get attached() {
    return this.placement !== null;
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
    this.host.style.transform = dpr === 1 ? 'none' : `scale(${1 / dpr})`;
    const rfb = this.rfb;
    if (!rfb) return;
    rfb.scaleViewport = !native;
    rfb.clipViewport = native;
    this.updateInput(native && rfb.clippingViewport, pan);
  }

  private updateInput(clipped: boolean, pan: boolean) {
    const rfb = this.rfb;
    if (!rfb) return;
    const watch = this.mode === 'watch';
    rfb.dragViewport = clipped && (watch || pan);
    // noVNC treats a drag below its movement threshold as a click.
    const viewOnly = watch || (clipped && pan);
    if (rfb.viewOnly !== viewOnly) {
      // noVNC's setter blocks sendKey before it ungrabs, so its own key release never reaches the Agent.
      if (viewOnly) this.releaseKeys();
      rfb.viewOnly = viewOnly;
    }
    rfb.focusOnClick = !viewOnly;
  }

  detach(listener: StreamListener) {
    if (this.listener !== listener) return;
    if (this.mode === 'watch') this.capture();
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

  /** Codes noVNC holds down on the remote end. */
  held(): ReadonlySet<string> {
    return new Set(Object.keys(this.rfb?._keyboard?._keyDownList ?? {}));
  }

  sendKeys(keys: readonly KeyStroke[]) {
    const rfb = this.rfb;
    if (!rfb) return;
    for (const [keysym, code, down] of keys) rfb.sendKey(keysym, code, down);
  }

  releaseKeys(options?: { exceptModifiers?: boolean }) {
    const rfb = this.rfb;
    const held = rfb?._keyboard?._keyDownList;
    if (rfb && held) releaseHeld(held, (keysym, code, down) => rfb.sendKey(keysym, code, down), options);
  }

  /** Give the Agent the Owner's text, then paste it there with Ctrl+V. */
  paste(text: string | null) {
    const rfb = this.rfb;
    if (!rfb) return;
    // Same socket, in order. Xvnc answers the app's selection request once noVNC provides the text.
    if (text) rfb.clipboardPasteFrom(text);
    this.sendKeys(pasteChord(this.held()));
  }

  reconnect() {
    if (this.mode === 'watch' && this.entry.control.attached) return;
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
      const watch = this.mode === 'watch';
      // Trade some JPEG quality for smaller updates and use fast compression while driving.
      rfb.qualityLevel = watch ? 8 : 6;
      rfb.compressionLevel = watch ? 2 : 1;
      if (!watch) rfb.showDotCursor = true;
      rfb.viewOnly = watch;
      rfb.resizeSession = false;
      rfb.background = 'transparent';
      rfb.focusOnClick = this.mode === 'control';

      // The host lays out in remote/device pixels and is transformed into CSS pixels.
      // noVNC's pointer events arrive in CSS pixels, so invert that transform for input.
      const display = rfb._display;
      const absX = display.absX.bind(display);
      const absY = display.absY.bind(display);
      const moveViewport = display.viewportChangePos.bind(display);
      display.absX = (x) => absX(x * (this.placement?.dpr ?? 1));
      display.absY = (y) => absY(y * (this.placement?.dpr ?? 1));
      display.viewportChangePos = (x, y) => {
        const dpr = rfb.dragViewport ? this.placement?.dpr ?? 1 : 1;
        moveViewport(x * dpr, y * dpr);
      };
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
            if (watch) this.capture();
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
        this.updateInput(rfb.clippingViewport, this.placement?.pan ?? false);
        this.publish();
      });
      rfb.addEventListener('disconnect', (event) => {
        if (this.rfb !== rfb) return;
        this.capture();
        this.handshaken = false;
        this.conn = (event as CustomEvent<{ clean: boolean }>).detail?.clean ? 'disconnected' : 'error';
        this.publish();
      });
      rfb.addEventListener('clipboard', (event) => {
        if (this.rfb !== rfb || this.mode !== 'control') return;
        const text = (event as CustomEvent<{ text: string }>).detail?.text;
        if (text) this.onClipboard?.(text);
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
    // Leave nothing held on the Agent's desktop when control ends.
    this.releaseKeys();
    this.capture();
    this.generation++;
    const rfb = this.rfb;
    this.rfb = null;
    this.painted = false;
    this.handshaken = false;
    this.conn = 'idle';
    rfb?.disconnect();
  }

  capture() {
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
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.watch.stop();
    }, WATCH_GRACE_MS);
  }
}

const screenEntries = new Map<string, ScreenEntry>();

function tabIsVisible() {
  return document.visibilityState === 'visible';
}

function disposeScreen(entry: ScreenEntry) {
  entry.retain();
  entry.watch.stop();
  entry.control.stop();
  entry.snapshot = null;
  screenEntries.delete(entry.botId);
}

function sameScreen(a: ScreenRegistration, b: ScreenRegistration | undefined) {
  return a.screenId === b?.screenId && a.revision === b.revision;
}

function getScreen(registration: ScreenRegistration) {
  const previous = screenEntries.get(registration.botId);
  if (previous && sameScreen(previous.registration, registration)) return previous;
  if (previous) disposeScreen(previous);
  const entry = new ScreenEntry(registration.botId, registration);
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
  if (state.computer !== previous?.computer) {
    for (const entry of screenEntries.values()) {
      const registration = state.computer?.screens.find((screen) => screen.botId === entry.botId);
      if (!sameScreen(entry.registration, registration)) disposeScreen(entry);
    }
  }
  const registration = state.user && state.computer?.screens.find((screen) => screen.botId === state.selectedBotId);
  const next = registration ? getScreen(registration) : undefined;
  if (selectedScreen === next) return;
  if (selectedScreen && screenEntries.get(selectedScreen.botId) === selectedScreen) selectedScreen.release();
  selectedScreen = next;
  next?.retain();
  if (tabIsVisible()) next?.watch.start(true);
}
const stopPrewarming = useStore.subscribe(prewarmSelection);
prewarmSelection(useStore.getState());

function syncWatchVisibility() {
  if (tabIsVisible()) selectedScreen?.watch.start(true);
  else for (const entry of screenEntries.values()) entry.watch.stop();
}
document.addEventListener('visibilitychange', syncWatchVisibility);

import.meta.hot?.dispose(() => {
  stopPrewarming();
  document.removeEventListener('visibilitychange', syncWatchVisibility);
  for (const entry of screenEntries.values()) disposeScreen(entry);
});

/** A panel preview or native-pixel stage for the Agent computer. */
export function ComputerScreen({ bot, variant, initialMode = 'watch', hint, paused = false, onExpand, onModeChange }: ScreenProps) {
  const computer = useStore((s) => s.computer);
  const userId = useStore((s) => s.user?.id);
  const frameRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef<HTMLDivElement>(null);
  const activeStream = useRef<ScreenStream | null>(null);

  const [mode, setMode] = useState<ScreenMode>(initialMode);
  const [frame, setFrame] = useState<StreamFrame>(EMPTY_FRAME);
  const [fullscreen, setFullscreen] = useState(false);
  const [visible, setVisible] = useState(tabIsVisible);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const [pan, setPan] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [mac] = useState(() => isMacPlatform(navigator as Navigator & { userAgentData?: { platform?: string } }));
  const [cmdAsCtrl, setCmdAsCtrl] = useState(readCmdAsCtrl);
  const [locked, setLocked] = useState(false);
  /** Text the Agent copied that the browser wouldn't let us put on the Owner's clipboard. */
  const [agentCopy, setAgentCopy] = useState<string | null>(null);

  const screen = computer?.screens.find((s) => s.botId === bot.id);
  const { width, height } = frame.size ?? screenSize(computer, bot.id, bot.isPrimary);
  const driving = mode === 'control';
  const large = variant === 'stage' || fullscreen;
  const { conn, clipped, snapshot } = frame;
  const screenId = screen?.screenId;
  const screenRevision = screen?.revision;

  useEffect(() => {
    const update = () => setVisible(tabIsVisible());
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

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

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const body = bodyRef.current;
    if (!large || !frame || !body) return;
    const grid = pixelGrid(dpr);
    // Align the rounded frame itself so the browser doesn't resample its clipped contents.
    const align = () => {
      const outer = frame.getBoundingClientRect();
      const inner = body.getBoundingClientRect();
      const x = outer.left + (outer.width - inner.width) / 2;
      const y = outer.top + (outer.height - inner.height) / 2;
      body.style.left = `${Math.round(x / grid) * grid - x}px`;
      body.style.top = `${Math.round(y / grid) * grid - y}px`;
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(frame);
    observer.observe(body);
    window.addEventListener('resize', align);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', align);
      body.style.left = body.style.top = '';
    };
  }, [dpr, fullscreen, large]);

  const placement = useRef<Placement | null>(null);
  useLayoutEffect(() => {
    const target = streamRef.current;
    if (!target) return;
    placement.current = { target, native: large, dpr, pan };
    activeStream.current?.layout(placement.current);
  }, [large, dpr, pan]);

  useLayoutEffect(() => {
    if (!userId || screenId === undefined || paused || !visible || !placement.current) {
      setFrame(EMPTY_FRAME);
      return;
    }
    const entry = getScreen({ botId: bot.id, screenId, revision: screenRevision });
    // Save the watch frame for the switch and stop its background decoding while driving.
    if (mode === 'control') entry.watch.stop();
    const stream = entry[mode];
    const update: StreamListener = setFrame;
    activeStream.current = stream;
    if (mode === 'control') stream.onClipboard = (text) => copyFromAgent.current(text);
    stream.attach(placement.current, update);
    stream.start(true);
    return () => {
      activeStream.current = null;
      stream.onClipboard = null;
      stream.detach(update);
      if (mode === 'control') {
        stream.stop();
        if (tabIsVisible() && (selectedScreen === entry || entry.watch.attached)) entry.watch.start(true);
      }
    };
  }, [userId, bot.id, screenId, screenRevision, mode, paused, visible]);

  useLayoutEffect(() => {
    const host = snapshotRef.current;
    const view = viewRef.current;
    if (!snapshot || !host || !view || paused || screenId === undefined || conn === 'connected') return;
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
        left: `${large ? 0 : Math.max(0, (view.clientWidth - w) / 2)}px`,
        top: `${large ? 0 : Math.max(0, (view.clientHeight - h) / 2)}px`,
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
  }, [snapshot, dpr, large, paused, screenId, conn]);

  useEffect(() => {
    if (mode === 'control' && conn === 'connected') activeStream.current?.focus();
  }, [mode, conn]);

  // Mac shortcuts while driving: Cmd acts as Ctrl on the Agent, and Cmd+V pastes the Owner's text there.
  const cmdAsCtrlRef = useRef(cmdAsCtrl);
  cmdAsCtrlRef.current = cmdAsCtrl;
  useEffect(() => {
    const frame = frameRef.current;
    if (!driving || !frame) return;
    let pasteFallback: ReturnType<typeof setTimeout> | undefined;
    let fellBackAt = -Infinity;
    // Only keys aimed at this screen; the rest of the page keeps its own shortcuts.
    const ours = (e: Event) => e.target instanceof Node && frame.contains(e.target);
    const options = () => ({ mac, cmdAsCtrl: cmdAsCtrlRef.current, held: activeStream.current?.held() });
    const down = (e: KeyboardEvent) => {
      if (!ours(e)) return;
      // macOS sends no keyup for keys released while Cmd is down; lift them now so none stick.
      if (e.metaKey && mac && cmdAsCtrlRef.current) activeStream.current?.releaseKeys({ exceptModifiers: true });
      const action = translateKeyDown(e, options());
      if (action.kind === 'pass') return;
      // Capture phase on window runs before noVNC's canvas listener.
      e.stopPropagation();
      if (action.kind === 'browser') return;
      if (action.kind === 'paste') {
        // Leave the default so the browser fires paste. Without one, paste the Agent's own clipboard.
        clearTimeout(pasteFallback);
        pasteFallback = setTimeout(() => {
          fellBackAt = performance.now();
          activeStream.current?.paste(null);
        }, 300);
        return;
      }
      e.preventDefault();
      if (action.kind === 'send') activeStream.current?.sendKeys(action.keys);
    };
    const up = (e: KeyboardEvent) => {
      if (!ours(e) || translateKeyUp(e, options()).kind !== 'drop') return;
      e.stopPropagation();
      e.preventDefault();
    };
    const paste = (e: ClipboardEvent) => {
      if (!ours(e)) return;
      clearTimeout(pasteFallback);
      e.preventDefault();
      e.stopPropagation();
      // A paste event that lands after the fallback already sent Ctrl+V would paste twice.
      if (performance.now() - fellBackAt < 2000) { fellBackAt = -Infinity; return; }
      activeStream.current?.paste(e.clipboardData?.getData('text/plain') || null);
    };
    // No stuck keys on the Agent when the Owner switches apps or tabs, or clicks away, mid-chord.
    const release = (e?: Event) => { if (!e || e.target === window || ours(e)) activeStream.current?.releaseKeys(); };
    const hidden = () => { if (!tabIsVisible()) release(); };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('paste', paste, true);
    window.addEventListener('blur', release, true);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      clearTimeout(pasteFallback);
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('paste', paste, true);
      window.removeEventListener('blur', release, true);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [driving, mac]);

  // Full screen + control: ask the browser for keys it otherwise keeps (Cmd+T, Cmd+W, Esc…).
  const keyboard = (navigator as Navigator & { keyboard?: { lock?(codes?: string[]): Promise<void>; unlock?(): void } }).keyboard;
  useEffect(() => {
    if (!driving || !fullscreen || !keyboard?.lock) return;
    let active = true;
    keyboard.lock(mac ? [...MAC_KEYBOARD_LOCK_CODES] : undefined).then(() => { if (active) setLocked(true); }, () => {});
    return () => {
      active = false;
      keyboard.unlock?.();
      setLocked(false);
      activeStream.current?.releaseKeys();
    };
  }, [driving, fullscreen, keyboard, mac]);

  const copyFromAgent = useRef<(text: string) => void>(() => {});
  copyFromAgent.current = (text) => {
    const copied = () => { setAgentCopy(null); setNote(`Copied from ${bot.name}’s computer`); };
    if (!navigator.clipboard?.writeText) { setAgentCopy(text); return; }
    // A remote copy usually lands after the key press's activation has expired; then offer a button.
    navigator.clipboard.writeText(text).then(copied, () => setAgentCopy(text));
  };
  const copyAgentText = () => {
    if (!agentCopy) return;
    const text = agentCopy;
    (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard'))).then(
      () => { setAgentCopy(null); setNote(`Copied from ${bot.name}’s computer`); },
      () => setNote('Your browser blocked the copy.'),
    );
    activeStream.current?.focus();
  };
  useEffect(() => { if (!driving) setAgentCopy(null); }, [driving]);

  const toggleCmdAsCtrl = () => {
    const next = !cmdAsCtrl;
    setCmdAsCtrl(next);
    writeCmdAsCtrl(next);
    activeStream.current?.focus();
  };

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
  const preview = variant === 'panel' && !fullscreen;
  const mascot = large ? 64 : 40;
  const canTakeControl = phase === 'live';
  const hasControls = driving || large;
  const panning = large && clipped && (!driving || pan);
  let keyHint: string | null = null;
  if (driving && phase === 'live') {
    if (locked) keyHint = 'Hold Esc to leave full screen';
    // Only browsers with keyboard lock get those keys in full screen, and only while ⌘ acts as Ctrl.
    else if (!fullscreen && canFullscreen && keyboard?.lock && (!mac || cmdAsCtrl)) keyHint = `Full screen sends ${mac ? '⌘T, ⌘W' : 'Ctrl+T, Ctrl+W'} to ${bot.name}`;
  }
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
      <div ref={bodyRef} className="screen__body">
        <div ref={viewRef} className="screen__view" style={large ? undefined : { aspectRatio: `${width} / ${height}` }}>
          <div className="screen__canvas">
            <div ref={streamRef} className="screen__stream" />
            <div ref={snapshotRef} className="screen__snapshot" aria-hidden />
          </div>
          {canTakeControl && !driving && !panning && (
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

          {note && !(preview && canTakeControl && !driving) && <span className="screen__note" role="status">{note}</span>}
          {canTakeControl && !driving && preview && (
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

        {hasControls && (
          <div className="screen__chin">
            <span className="screen__chin-text" role="status">
              {driving && phase === 'live' && <i className="screen__ping" aria-hidden />}
              <span>{phase === 'live' ? driving ? hint || 'You have control' : 'Watching' : ''}</span>
              {keyHint && <span className="screen__chin-hint">{keyHint}</span>}
            </span>
            <span className="screen__chin-actions">
              {driving && clipped && (
                <button type="button" className="screen__pan" aria-pressed={pan} onClick={() => setPan(!pan)}>
                  Pan screen
                </button>
              )}
              {driving && agentCopy && (
                <button type="button" className="screen__pan" onClick={copyAgentText}>Copy to my clipboard</button>
              )}
              {driving && mac && (
                <button type="button" className="screen__pan" aria-pressed={cmdAsCtrl} onClick={toggleCmdAsCtrl}
                  title={`Cmd acts as Ctrl on ${bot.name}’s computer`}>⌘ as Ctrl</button>
              )}
              {canFullscreen && (
                <button type="button" className="screen__chin-icon" onClick={toggleFullscreen} aria-label={fullscreen ? 'Leave full screen' : 'Full screen'} title={fullscreen ? 'Leave full screen' : 'Full screen'}>
                  <Icon name={fullscreen ? 'shrink' : 'expand'} size={15} />
                </button>
              )}
              {driving ? (
                <button type="button" className="screen__handback" onClick={handBack}>Return control</button>
              ) : (
                <button type="button" className="screen__handback" onClick={takeControl} disabled={!canTakeControl}
                  aria-label={panning ? `Take control of ${bot.name}’s computer` : undefined}>Take control</button>
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
