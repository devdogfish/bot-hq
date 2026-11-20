import assert from 'node:assert/strict';
import test from 'node:test';

const keys = await import('../web/src/components/computer-keys.ts');
const { XK, translateKeyDown, translateKeyUp, keysymFor, chord, pasteChord, forwardNativePaste, releaseHeld, releaseKeysForCmd, isMacPlatform, readCmdAsCtrl, writeCmdAsCtrl, CMD_AS_CTRL_KEY, MAC_KEYBOARD_LOCK_CODES } = keys;

const mac = { mac: true, cmdAsCtrl: true };
const key = (code, mods = {}) => ({ code, metaKey: false, shiftKey: false, altKey: false, repeat: false, ...mods });
const cmd = (code, mods = {}) => key(code, { metaKey: true, ...mods });
const sym = (ch) => ch.charCodeAt(0);
const ctrlChord = (code, ch) => [
  [XK.Control_L, 'ControlLeft', true],
  [sym(ch), code, true],
  [sym(ch), code, false],
  [XK.Control_L, 'ControlLeft', false],
];

test('Cmd+T/W/L/R/C/A/Z become Ctrl chords with lowercase keysyms', () => {
  for (const letter of 'TWLRCAZ') {
    const code = `Key${letter}`;
    assert.deepEqual(translateKeyDown(cmd(code), mac), { kind: 'send', keys: ctrlChord(code, letter.toLowerCase()) });
  }
});

test('Cmd never reaches the Agent as Alt or Super', () => {
  assert.deepEqual(translateKeyDown(key('MetaLeft', { metaKey: true }), mac), { kind: 'drop' });
  assert.deepEqual(translateKeyDown(key('MetaRight', { metaKey: true }), mac), { kind: 'drop' });
  assert.deepEqual(translateKeyUp(key('MetaLeft'), mac), { kind: 'drop' });
  for (const code of ['KeyT', 'KeyW', 'KeyZ', 'ArrowLeft', 'Backspace', 'Digit1', 'BracketLeft']) {
    const action = translateKeyDown(cmd(code), mac);
    assert.equal(action.kind, 'send', code);
    for (const [keysym] of action.keys) assert.ok(keysym !== XK.Alt_L && keysym !== XK.Super_L && keysym !== 0xff7e, code);
  }
});

test('Cmd+V hands off to the native paste event', () => {
  assert.deepEqual(translateKeyDown(cmd('KeyV'), mac), { kind: 'paste' });
  assert.deepEqual(pasteChord(), ctrlChord('KeyV', 'v'));
  // Cmd+Shift+V is a plain chord (paste without formatting in many apps).
  assert.equal(translateKeyDown(cmd('KeyV', { shiftKey: true }), mac).kind, 'send');
  assert.equal(translateKeyDown(key('KeyV', { ctrlKey: true }), { mac: false, cmdAsCtrl: true }).kind, 'pass');
});

test('fullscreen Mac lock leaves native Paste available and captures Esc and tab shortcuts', () => {
  for (const code of ['KeyV', 'KeyQ', 'Tab']) assert.ok(!MAC_KEYBOARD_LOCK_CODES.includes(code), code);
  for (const code of ['Escape', 'KeyT', 'KeyW', 'KeyL', 'KeyR', 'KeyN']) {
    assert.ok(MAC_KEYBOARD_LOCK_CODES.includes(code), code);
  }
});

test('each trusted native paste is forwarded once without coalescing two pastes', () => {
  const actions = [];
  const pasteEvent = (text, isTrusted = true) => ({
    isTrusted,
    clipboardData: { getData: (format) => {
      assert.equal(format, 'text/plain');
      return text;
    } },
    preventDefault: () => actions.push('preventDefault'),
    stopPropagation: () => actions.push('stopPropagation'),
  });
  const paste = (text) => actions.push(text);
  forwardNativePaste(pasteEvent('first'), paste);
  forwardNativePaste(pasteEvent('second'), paste);
  forwardNativePaste(pasteEvent('synthetic', false), paste);
  assert.deepEqual(actions, [
    'preventDefault', 'stopPropagation', 'first',
    'preventDefault', 'stopPropagation', 'second',
  ]);
});

test('Shift combos add Shift and the shifted keysym', () => {
  assert.deepEqual(translateKeyDown(cmd('KeyT', { shiftKey: true }), mac), {
    kind: 'send',
    keys: [
      [XK.Control_L, 'ControlLeft', true],
      [XK.Shift_L, 'ShiftLeft', true],
      [sym('T'), 'KeyT', true],
      [sym('T'), 'KeyT', false],
      [XK.Shift_L, 'ShiftLeft', false],
      [XK.Control_L, 'ControlLeft', false],
    ],
  });
  // Shift already held on the Agent (pressed before Cmd): don't press or release it again.
  const held = new Set(['ShiftLeft']);
  assert.deepEqual(translateKeyDown(cmd('KeyZ', { shiftKey: true }), { ...mac, held }), { kind: 'send', keys: ctrlChord('KeyZ', 'Z') });
  // A modifier pressed while Cmd is down stays out of noVNC; the chord carries it.
  assert.deepEqual(translateKeyDown(cmd('ShiftLeft', { shiftKey: true }), mac), { kind: 'drop' });
});

test('Ctrl already held on the Agent is not pressed twice', () => {
  const action = translateKeyDown(cmd('KeyC'), { ...mac, held: new Set(['ControlLeft']) });
  assert.deepEqual(action, { kind: 'send', keys: [[sym('c'), 'KeyC', true], [sym('c'), 'KeyC', false]] });
});

test('OS-owned shortcuts and tab-storm repeats are not forwarded', () => {
  for (const code of ['KeyQ', 'Tab', 'Space', 'KeyH', 'KeyM']) assert.deepEqual(translateKeyDown(cmd(code), mac), { kind: 'browser' }, code);
  assert.deepEqual(translateKeyDown(cmd('KeyT', { repeat: true }), mac), { kind: 'drop' });
  assert.equal(translateKeyDown(cmd('KeyZ', { repeat: true }), mac).kind, 'send');
});

test('plain keys, the toggle off and non-Mac clients go to noVNC unchanged', () => {
  assert.deepEqual(translateKeyDown(key('KeyT'), mac), { kind: 'pass' });
  assert.deepEqual(translateKeyDown(key('KeyC', { ctrlKey: true }), mac), { kind: 'pass' });
  assert.deepEqual(translateKeyDown(cmd('KeyT'), { mac: true, cmdAsCtrl: false }), { kind: 'pass' });
  assert.deepEqual(translateKeyDown(cmd('KeyT'), { mac: false, cmdAsCtrl: true }), { kind: 'pass' });
  assert.deepEqual(translateKeyUp(key('MetaLeft'), { mac: true, cmdAsCtrl: false }), { kind: 'pass' });
  assert.deepEqual(translateKeyUp(key('KeyT'), mac), { kind: 'pass' });
});

test('keysyms for letters, digits, punctuation, function and special keys', () => {
  assert.equal(keysymFor('KeyA', false), sym('a'));
  assert.equal(keysymFor('KeyA', true), sym('A'));
  assert.equal(keysymFor('Digit1', true), sym('!'));
  assert.equal(keysymFor('Slash', false), sym('/'));
  assert.equal(keysymFor('F1', false), 0xffbe);
  assert.equal(keysymFor('F12', false), 0xffc9);
  assert.equal(keysymFor('Escape', false), 0xff1b);
  assert.equal(keysymFor('ArrowLeft', false), 0xff51);
  assert.equal(keysymFor('IntlRo', false), 0);
  assert.deepEqual(chord('KeyT', sym('t'), { alt: true }).map(([k, , d]) => [k, d]), [
    [XK.Control_L, true], [XK.Alt_L, true], [sym('t'), true], [sym('t'), false], [XK.Alt_L, false], [XK.Control_L, false],
  ]);
});

test('releaseHeld lifts every held key once and empties the list', () => {
  const held = { ShiftLeft: 0xffe1, ControlLeft: XK.Control_L, KeyA: sym('a') };
  const sent = [];
  releaseHeld(held, (keysym, code, down) => sent.push([keysym, code, down]));
  assert.deepEqual(sent.sort(), [[0xffe1, 'ShiftLeft', false], [XK.Control_L, 'ControlLeft', false], [sym('a'), 'KeyA', false]].sort());
  assert.deepEqual(held, {});
  releaseHeld(held, () => assert.fail('nothing left to release'));
});

test('Cmd transitions release keys that can miss keyup and preserve physically held modifiers', () => {
  const held = { KeyA: sym('a'), ShiftRight: 0xffe2, ControlLeft: XK.Control_L };
  const sent = [];
  const send = (...stroke) => sent.push(stroke);
  releaseKeysForCmd(held, { shiftKey: true, ctrlKey: true, altKey: false }, send);
  assert.deepEqual(held, { ShiftRight: 0xffe2, ControlLeft: XK.Control_L });
  releaseKeysForCmd(held, { shiftKey: false, ctrlKey: true, altKey: false }, send);
  assert.deepEqual(held, { ControlLeft: XK.Control_L });
  assert.deepEqual(sent, [[sym('a'), 'KeyA', false], [0xffe2, 'ShiftRight', false]]);
});

test('platform detection and the remembered toggle', () => {
  assert.equal(isMacPlatform({ platform: 'MacIntel' }), true);
  assert.equal(isMacPlatform({ userAgentData: { platform: 'macOS' } }), true);
  assert.equal(isMacPlatform({ platform: 'Linux x86_64' }), false);
  assert.equal(isMacPlatform(undefined), false);

  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(readCmdAsCtrl(storage), true, 'on by default');
  writeCmdAsCtrl(false, storage);
  assert.equal(store.get(CMD_AS_CTRL_KEY), 'off');
  assert.equal(readCmdAsCtrl(storage), false);
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(readCmdAsCtrl(broken), true);
  assert.doesNotThrow(() => writeCmdAsCtrl(true, broken));
});
