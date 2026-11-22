/**
 * The Messages send motion, fitted frame by frame to a 60 fps recording of macOS Messages
 * (t = 0 is the frame the input clears):
 *
 * - The bubble is born as the input field: field-wide, at ~12% opacity, which tints the field.
 * - Within ~50 ms it shrinks to 79% scale and lifts out; the field flashes lighter (peak at 83 ms,
 *   gone by 355 ms). Opacity reaches 69% at 50 ms and 100% by ~230 ms.
 * - Its width collapses from the field's to the text's (spring, damping 0.78, response 243 ms),
 *   anchored on the right edge, which moves to the bubble's column (damping 0.81, response 462 ms).
 * - It rises to its slot on a spring (damping 0.73, response 520 ms) that overshoots ~4% and settles.
 * - From 185 ms it grows back to full size (damping 0.68, response 490 ms) and gets its tail.
 *
 * Messages starts this on the send frame, before the conversation has the message, so the landing
 * box is predicted from a hidden measuring bubble. When the real row renders (see Transcript), any
 * difference between the prediction and the real bubble is folded in while the ghost is still flying.
 */

type Spring = { damping: number; response: number; delay: number };
const Y: Spring = { damping: 0.73, response: 0.52, delay: 0.0175 };
const RIGHT: Spring = { damping: 0.81, response: 0.4625, delay: -0.015 };
const WIDTH: Spring = { damping: 0.78, response: 0.2425, delay: 0.0025 };
const GROW: Spring = { damping: 0.68, response: 0.49, delay: 0.185 };
const SHRUNK = 0.79;
/** Opacity samples read off the recording: [seconds, opacity]. */
const OPACITY: [number, number][] = [[0, 0.12], [0.033, 0.4], [0.05, 0.69], [0.067, 0.72], [0.083, 0.765], [0.1, 0.81], [0.122, 0.87], [0.138, 0.9], [0.155, 0.95], [0.188, 0.98], [0.228, 1]];
/** The field's lighter flash after the bubble leaves it: [seconds, share of the peak]. */
const FLASH: [number, number][] = [[0, 0], [0.033, 0], [0.05, 0.38], [0.067, 0.46], [0.083, 1], [0.1, 0.96], [0.122, 0.92], [0.138, 0.88], [0.155, 0.85], [0.178, 0.73], [0.188, 0.65], [0.212, 0.58], [0.228, 0.42], [0.245, 0.31], [0.262, 0.27], [0.283, 0.15], [0.3, 0.12], [0.317, 0.08], [0.333, 0.04], [0.355, 0]];
/** Peak flash: +26 of 255 luminance over the field in the recording. */
const FLASH_ALPHA = 0.11;
/** The tail shows once the bubble is back to full size. */
const TAIL_AT = 0.37;

export const FLIGHT_MS = 800;
const FPS = 60;
const TAKE_WITHIN_MS = 8000;

function spring({ damping: z, response, delay }: Spring, t: number) {
  const tt = Math.max(0, t - delay);
  const w = (2 * Math.PI) / response;
  if (z >= 1) return 1 - Math.exp(-w * tt) * (1 + w * tt);
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * tt) * (Math.cos(wd * tt) + ((z * w) / wd) * Math.sin(wd * tt));
}
/** A spring whose delay is negative is already under way at t = 0; renormalise it to start at 0. */
const fromZero = (s: Spring, t: number) => { const s0 = spring(s, 0); return (spring(s, t) - s0) / (1 - s0); };
function table(points: [number, number][], t: number) {
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i];
    if (t <= t1) { const [t0, v0] = points[i - 1]; return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0); }
  }
  return points[points.length - 1][1];
}
function scaleAt(t: number) {
  if (t < 0.05) { const p = t / 0.05; return 1 - (1 - SHRUNK) * (1 - (1 - p) * (1 - p)); }
  return SHRUNK + (1 - SHRUNK) * spring(GROW, t);
}

/** The list's slide when a message arrives uses the same vertical spring, as a CSS easing. */
export const SLIDE_MS = FLIGHT_MS;
export const SLIDE_EASING = `linear(${Array.from({ length: 49 }, (_, i) => (i === 48 ? 1 : spring({ ...Y, delay: 0 }, (i / 48) * (SLIDE_MS / 1000))).toFixed(4)).join(', ')})`;

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Box { right: number; cy: number; w: number; h: number }
interface Pending {
  botId: string; text: string; ghost: HTMLDivElement; at: number; timer: number;
  /** Where the ghost was told to land; the real bubble may differ slightly. */
  target: Box; flight: Animation;
}
let pending: Pending | null = null;
/** Ghosts whose row has rendered: the bubble to reveal when the ghost lands. */
const landing = new WeakMap<HTMLDivElement, HTMLElement>();
/** Flights in the air whose bubble has rendered, re-aimed whenever the conversation's layout changes. */
const active = new Set<{ p: Pending; bubble: HTMLElement; correction: Animation | null; dx: number; dy: number }>();

function drop(p: Pending, fade: boolean) {
  clearTimeout(p.timer);
  if (pending === p) pending = null;
  if (!fade) { p.ghost.remove(); return; }
  p.ghost.animate([{ opacity: getComputedStyle(p.ghost).opacity }, { opacity: 0 }], { duration: 160, easing: 'ease-out', composite: 'replace' })
    .finished.then(() => p.ghost.remove(), () => p.ghost.remove());
}

/** Measure where a new Owner bubble with this text will sit, before the conversation renders it. */
function predict(text: string): (Box & { radius: string; bg: string; color: string; finalRadius: string }) | null {
  const col = document.querySelector<HTMLElement>('.transcript__col');
  if (!col) return null;
  const probe = document.createElement('div');
  probe.className = 'group is-right';
  probe.style.cssText = 'position:absolute;left:0;right:0;bottom:0;visibility:hidden;pointer-events:none;';
  const wrap = document.createElement('div');
  wrap.className = 'bubble-wrap is-right';
  const bubble = document.createElement('div');
  const prev = col.lastElementChild;
  const joins = !!prev?.classList.contains('group') && prev.classList.contains('is-right');
  bubble.className = `bubble is-user${joins ? ' is-last' : ''}`;
  const plain = document.createElement('div');
  plain.className = 'bubble__plain';
  plain.textContent = text;
  bubble.appendChild(plain);
  wrap.appendChild(bubble);
  probe.appendChild(wrap);
  col.appendChild(probe);
  const r = bubble.getBoundingClientRect();
  const bs = getComputedStyle(bubble);
  const out = { right: r.right, w: r.width, h: r.height, radius: getComputedStyle(document.documentElement).getPropertyValue('--radius-bubble') || '18px', finalRadius: bs.borderRadius, bg: bs.backgroundColor, color: bs.color, cy: 0 };
  probe.remove();
  // Pinned to the bottom (sending always scrolls there), the new bubble's bottom is the column's.
  const scroller = col.closest<HTMLElement>('.transcript');
  const bottom = scroller ? scroller.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(scroller).paddingBottom) || 0) : col.getBoundingClientRect().bottom;
  out.cy = bottom - out.h / 2;
  return out;
}

/** Send the typed text off as its bubble, starting this frame. Call just before the input is cleared. */
export function markSent(botId: string, text: string, input: HTMLTextAreaElement) {
  if (pending) drop(pending, false);
  if (reducedMotion()) return;
  const target = predict(text);
  if (!target) return;
  const field = input.getBoundingClientRect();
  const cs = getComputedStyle(input);
  const lineH = parseFloat(cs.lineHeight) || 22;
  const pt = parseFloat(cs.paddingTop) || 0;
  const pb = parseFloat(cs.paddingBottom) || 0;
  // The field the bubble is born from: the input's own box (single line: its line plus padding).
  const fieldH = Math.min(field.height, lineH + pt + pb);
  const fieldCy = field.top + pt + lineH / 2 - input.scrollTop;
  const startCy = fieldCy - 0.2 * fieldH; // born slightly above the field's middle (836 vs 842 of a 28px field)

  const ghost = document.createElement('div');
  ghost.className = 'send-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  // The text keeps its final wrap width, so it never reflows while the box narrows; it rides the left edge.
  const inner = document.createElement('span');
  inner.className = 'send-ghost__text';
  inner.style.width = `${target.w - 24}px`;
  inner.textContent = text;
  ghost.appendChild(inner);
  ghost.style.right = `${document.documentElement.clientWidth - target.right}px`;
  ghost.style.top = `${target.cy - target.h / 2}px`;
  ghost.style.height = `${target.h}px`;
  ghost.style.backgroundColor = target.bg;
  ghost.style.color = target.color;
  document.body.appendChild(ghost);

  const frames: Keyframe[] = [];
  const n = Math.round((FLIGHT_MS / 1000) * FPS);
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * (FLIGHT_MS / 1000);
    const s = scaleAt(t);
    const c = Math.min(1, spring(WIDTH, t));
    const screenW = field.width * (1 - c) + target.w * s * c;
    const right = field.right + (target.right - field.right) * fromZero(RIGHT, t);
    const cy = startCy + (target.cy - startCy) * spring(Y, t);
    const tail = Math.min(1, Math.max(0, (t - TAIL_AT) / 0.06));
    frames.push({
      offset: i / n,
      width: `${screenW / s}px`,
      transform: `translate(${right - target.right}px, ${cy - target.cy}px) scale(${s})`,
      opacity: table(OPACITY, t),
      color: t < 0.05 ? cs.color : target.color,
      borderRadius: tail < 1 ? target.radius : target.finalRadius,
    });
  }
  const flight = ghost.animate(frames, { duration: FLIGHT_MS, easing: 'linear', fill: 'forwards' });
  const done = () => {
    const bubble = landing.get(ghost);
    if (bubble) { bubble.style.opacity = ''; ghost.remove(); }
    for (const a of active) if (a.p.ghost === ghost) active.delete(a);
  };
  flight.finished.then(done, () => {});

  // The field flashes lighter as the bubble leaves it.
  const composer = input.closest<HTMLElement>('.composer');
  if (composer) {
    const base = getComputedStyle(composer).boxShadow;
    const ink = (cs.color.match(/[\d.]+/g) ?? ['127', '127', '127']).slice(0, 3).join(', ');
    const shadow = (a: number) => `inset 0 0 0 100vmax rgba(${ink}, ${(a * FLASH_ALPHA).toFixed(4)})${base && base !== 'none' ? `, ${base}` : ''}`;
    composer.animate(FLASH.map(([t, a]) => ({ offset: t / FLASH[FLASH.length - 1][0], boxShadow: shadow(a) })), { duration: FLASH[FLASH.length - 1][0] * 1000, easing: 'linear' });
  }

  const p: Pending = { botId, text: text.trim(), ghost, at: Date.now(), timer: 0, target, flight };
  p.timer = window.setTimeout(() => drop(p, true), TAKE_WITHIN_MS);
  pending = p;
}

/** The send failed: put the ghost away (the composer restores the text). */
export function cancelSent(botId: string, text: string) {
  if (pending && pending.botId === botId && pending.text === text.trim()) drop(pending, true);
}

/** The flight for the bubble with this text, once. Null when it was not just sent from here. */
export function takeFlight(botId: string, text: string): Pending | null {
  const p = pending;
  if (!p || p.botId !== botId || p.text !== text.trim() || Date.now() - p.at > TAKE_WITHIN_MS) return null;
  clearTimeout(p.timer);
  pending = null;
  return p;
}

/**
 * The real bubble has rendered and layout is final (scroll pinned): hide it until the ghost lands on it.
 * `colOffset` is any slide transform still applied to the conversation, which the landing spot excludes.
 */
export function land(p: Pending, bubble: HTMLElement, colOffset = 0) {
  bubble.style.opacity = '0';
  landing.set(p.ghost, bubble);
  if (p.flight.playState === 'finished') { bubble.style.opacity = ''; p.ghost.remove(); return; }
  active.add({ p, bubble, correction: null, dx: 0, dy: 0 });
  retarget(colOffset);
}

/**
 * Fold any difference between where a ghost is heading and where its bubble now rests into the rest of
 * the flight: the prediction can be off, and rows arriving mid-flight (a quick reply) move the bubble.
 */
export function retarget(colOffset = 0) {
  for (const a of active) {
    const { p, bubble } = a;
    if (!bubble.isConnected || p.flight.playState === 'finished') { active.delete(a); continue; }
    const r = bubble.getBoundingClientRect();
    const dx = r.right - p.target.right;
    const dy = r.top - colOffset + r.height / 2 - p.target.cy;
    if (Math.abs(dx - a.dx) < 0.5 && Math.abs(dy - a.dy) < 0.5) continue;
    const from = getComputedStyle(p.ghost).translate;
    a.correction?.cancel();
    a.dx = dx; a.dy = dy;
    const left = FLIGHT_MS - Number(p.flight.currentTime ?? 0);
    // `translate` composes with the flight's `transform`, so the correction rides on top of it.
    a.correction = p.ghost.animate([{ translate: from === 'none' ? '0 0' : from }, { translate: `${dx}px ${dy}px` }], { duration: Math.max(120, left), easing: SLIDE_EASING, fill: 'forwards' });
  }
}
