// Keyboard translation for driving an Agent's Linux desktop from a Mac.
// noVNC 1.7 sends the left Cmd key as Alt_L on macOS, so Cmd+T reaches the Agent as Alt+t.
// While "Cmd acts as Ctrl" is on, Cmd never reaches noVNC: Cmd+<key> becomes a Ctrl chord
// sent straight to the RFB with X keysyms, and Cmd itself is never sent as Alt or Super.

export type KeyStroke = readonly [keysym: number, code: string, down: boolean];

export type KeyAction =
  /** Not ours: let noVNC handle the event as usual. */
  | { kind: 'pass' }
  /** Keep it from noVNC and the page, and send nothing. */
  | { kind: 'drop' }
  /** Keep it from noVNC but leave the browser/OS default alone (Cmd+Q, Cmd+Tab…). */
  | { kind: 'browser' }
  /** Let the native paste event fire; the paste handler syncs the clipboard and sends Ctrl+V. */
  | { kind: 'paste' }
  | { kind: 'send'; keys: KeyStroke[] };

export interface KeyInput {
  code: string;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
}

export interface KeyOptions {
  mac: boolean;
  cmdAsCtrl: boolean;
  /** Codes noVNC currently holds down on the remote end. */
  held?: ReadonlySet<string>;
}

export const XK = {
  Control_L: 0xffe3,
  Shift_L: 0xffe1,
  Alt_L: 0xffe9,
  Super_L: 0xffeb,
} as const;

const SPECIAL: Record<string, number> = {
  Escape: 0xff1b, Enter: 0xff0d, NumpadEnter: 0xff8d, Backspace: 0xff08, Tab: 0xff09, Delete: 0xffff,
  Insert: 0xff63, Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56,
  ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54, Space: 0x20,
};

// US layout by physical key: [unshifted, shifted]. Shortcuts follow key position, like the Agent's keymap.
const PRINTABLE: Record<string, string> = {
  Minus: '-_', Equal: '=+', BracketLeft: '[{', BracketRight: ']}', Backslash: '\\|', Semicolon: ';:',
  Quote: '\'"', Comma: ',<', Period: '.>', Slash: '/?', Backquote: '`~',
  Digit1: '1!', Digit2: '2@', Digit3: '3#', Digit4: '4$', Digit5: '5%',
  Digit6: '6^', Digit7: '7&', Digit8: '8*', Digit9: '9(', Digit0: '0)',
};

const MODIFIERS = new Set([
  'MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'CapsLock', 'Fn',
]);

/** Cmd shortcuts macOS or the browser keep; never forwarded to the Agent. */
const OS_OWNED = new Set(['KeyQ', 'Tab', 'Space', 'KeyH', 'KeyM', 'Backquote']);
/** Held-down repeats of these would open or close tabs/windows in a burst. */
const NO_REPEAT = new Set(['KeyT', 'KeyW', 'KeyN', 'KeyR']);

/** X keysym for a physical key code, or 0 when there is none. */
export function keysymFor(code: string, shift: boolean): number {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return (shift ? letter[1] : letter[1].toLowerCase()).charCodeAt(0);
  const printable = PRINTABLE[code];
  if (printable) return printable.charCodeAt(shift ? 1 : 0);
  const fn = /^F([1-9]|1[0-2])$/.exec(code);
  if (fn) return 0xffbe + Number(fn[1]) - 1;
  return SPECIAL[code] ?? 0;
}

function holds(held: ReadonlySet<string> | undefined, side: string) {
  return !!held && (held.has(`${side}Left`) || held.has(`${side}Right`));
}

/**
 * A tapped chord: modifiers down, key down and up, modifiers up in reverse.
 * macOS sends no keyup for keys pressed while Cmd is held, so nothing stays down.
 */
export function chord(code: string, keysym: number, mods: { shift?: boolean; alt?: boolean } = {}, held?: ReadonlySet<string>): KeyStroke[] {
  const wrap: KeyStroke[] = [];
  if (!holds(held, 'Control')) wrap.push([XK.Control_L, 'ControlLeft', true]);
  if (mods.shift && !holds(held, 'Shift')) wrap.push([XK.Shift_L, 'ShiftLeft', true]);
  if (mods.alt && !holds(held, 'Alt')) wrap.push([XK.Alt_L, 'AltLeft', true]);
  const release = wrap.map(([sym, c]) => [sym, c, false] as const).reverse();
  return [...wrap, [keysym, code, true], [keysym, code, false], ...release];
}

/** The Ctrl+V chord sent to the Agent after its clipboard has the Owner's text. */
export function pasteChord(held?: ReadonlySet<string>): KeyStroke[] {
  return chord('KeyV', keysymFor('KeyV', false), {}, held);
}

export function translateKeyDown(e: KeyInput, { mac, cmdAsCtrl, held }: KeyOptions): KeyAction {
  if (!mac || !cmdAsCtrl) return { kind: 'pass' };
  if (e.code === 'MetaLeft' || e.code === 'MetaRight') return { kind: 'drop' };
  if (!e.metaKey) return { kind: 'pass' };
  // noVNC would tap a modifier pressed while Cmd is down; the chord adds Shift/Alt itself.
  if (MODIFIERS.has(e.code)) return e.code === 'CapsLock' ? { kind: 'pass' } : { kind: 'drop' };
  if (OS_OWNED.has(e.code)) return { kind: 'browser' };
  if (e.code === 'KeyV' && !e.shiftKey && !e.altKey) return { kind: 'paste' };
  if (e.repeat && NO_REPEAT.has(e.code)) return { kind: 'drop' };
  const keysym = keysymFor(e.code, e.shiftKey);
  if (!keysym) return { kind: 'drop' };
  return { kind: 'send', keys: chord(e.code, keysym, { shift: e.shiftKey, alt: e.altKey }, held) };
}

export function translateKeyUp(e: Pick<KeyInput, 'code'>, { mac, cmdAsCtrl }: KeyOptions): KeyAction {
  if (!mac || !cmdAsCtrl) return { kind: 'pass' };
  return e.code === 'MetaLeft' || e.code === 'MetaRight' ? { kind: 'drop' } : { kind: 'pass' };
}

/** Release every key noVNC holds on the remote end, so nothing sticks after blur or hand back. */
export function releaseHeld(held: Record<string, number>, send: (keysym: number, code: string, down: boolean) => void) {
  for (const code of Object.keys(held)) {
    const keysym = held[code];
    delete held[code];
    send(keysym, code, false);
  }
}

export function isMacPlatform(nav: { platform?: string; userAgentData?: { platform?: string } } | undefined): boolean {
  const platform = nav?.userAgentData?.platform || nav?.platform || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export const CMD_AS_CTRL_KEY = 'bothq.screen.cmdAsCtrl';

export function readCmdAsCtrl(storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    return (storage ?? localStorage).getItem(CMD_AS_CTRL_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function writeCmdAsCtrl(on: boolean, storage?: Pick<Storage, 'setItem'>) {
  try {
    (storage ?? localStorage).setItem(CMD_AS_CTRL_KEY, on ? 'on' : 'off');
  } catch {
    // Private windows and blocked storage: the toggle still works for this page.
  }
}
