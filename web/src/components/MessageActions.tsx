import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft } from 'lucide-react';
import type { Bot, MessageBody, ReactionKind, Row } from '@shared/types';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { useStore, isArchived } from '../store';
import { REACTION_KINDS, REACTION_LABEL, TapbackGlyph } from './tapbacks';

/**
 * The Messages press-and-hold layer for one bubble: the page dims, the bubble lifts, the tapback row springs
 * in above it (Agent messages) and a context menu sits under it (right-click, long-press, ContextMenu key).
 * A double-click opens only the tapback row. Escape, a click on the dimmed page or a choice closes it.
 */
export type ActionsMode = 'menu' | 'picker';

const MARGIN = 8;
const ROW_H = 44;
const PICKED_MS = 280;

export function MessageActions({ bot, row, anchor, mode, onClose }: {
  bot: Bot; row: Row; anchor: HTMLElement; mode: ActionsMode; onClose: () => void;
}) {
  const b = row.body as MessageBody;
  const fromAgent = b.role === 'assistant';
  const side = anchor.classList.contains('is-user') ? 'right' : 'left';
  const [rect] = useState(() => anchor.getBoundingClientRect());
  const [picked, setPicked] = useState<ReactionKind | 'none' | null>(null);
  const [forwarding, setForwarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lift = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const bots = useStore((s) => s.bots);
  const pendingArchive = useStore((s) => s.pendingArchive);

  // The lifted bubble is a copy of the real one, so the transcript itself never moves.
  useLayoutEffect(() => {
    const host = lift.current;
    if (!host) return;
    const copy = anchor.cloneNode(true) as HTMLElement;
    copy.removeAttribute('tabindex');
    copy.querySelector('.tapback')?.classList.remove('is-new');
    host.appendChild(copy);
    return () => { copy.remove(); };
  }, [anchor]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', key, true);
    const first = (menu.current ?? picker.current)?.querySelector<HTMLElement>('button:not(:disabled)');
    first?.focus({ preventScroll: true });
    return () => { document.removeEventListener('keydown', key, true); anchor.focus({ preventScroll: true }); };
  }, [onClose, anchor, forwarding]);

  const react = (kind: ReactionKind) => {
    const next = b.reaction?.kind === kind ? 'none' : kind;
    setPicked(next);
    api.reactToRow(row.botId, row.seq, next).catch((e: Error) => setError(e.message || 'Couldn’t save the reaction.'));
    setTimeout(onClose, PICKED_MS);
  };
  const reply = () => {
    window.dispatchEvent(new CustomEvent('bothq:quote', { detail: { botId: row.botId, text: b.text } }));
    onClose();
  };
  const copy = () => {
    navigator.clipboard?.writeText(b.text).catch(() => {});
    onClose();
  };
  const selectText = () => {
    onClose();
    requestAnimationFrame(() => {
      // The message text only: not the tapback badge or the "Draft only" label.
      const parts = [...anchor.children].filter((el) => !el.matches('.tapback, .bubble__draft'));
      if (!parts.length) return;
      const sel = window.getSelection();
      sel?.removeAllRanges();
      const range = document.createRange();
      range.setStartBefore(parts[0]);
      range.setEndAfter(parts[parts.length - 1]);
      sel?.addRange(range);
    });
  };
  // James and the business Agents never exchange messages (Quantself ADR 0060); the server checks it too.
  const targets = bots.filter((t) => t.id !== bot.id && t.kind !== 'room' && !t.paused
    && !isArchived(t, pendingArchive) && !!t.isPersonal === !!bot.isPersonal);
  const forward = (to: Bot) => {
    api.forwardRow(row.botId, row.seq, to.id).then(onClose, (e: Error) => setError(e.message || 'Couldn’t forward it.'));
  };

  const menuKeys = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };
  const pickerKeys = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const items = [...(picker.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  // Tapback row above the bubble, the menu under it; either flips when the window edge is near.
  const vw = window.innerWidth, vh = window.innerHeight;
  const rowTop = rect.top - ROW_H - MARGIN >= MARGIN ? rect.top - ROW_H - MARGIN : rect.bottom + MARGIN;
  const rowBelow = rowTop > rect.top;
  const menuTop = rowBelow ? rect.bottom + ROW_H + MARGIN * 2 : rect.bottom + MARGIN;
  const menuFlip = menuTop + 220 > vh;
  const align = side === 'right'
    ? { right: Math.max(MARGIN, vw - rect.right) }
    : { left: Math.max(MARGIN, rect.left) };
  const showPicker = fromAgent;

  return createPortal(
    <div className="msg-actions" role="presentation" style={botVars(bot.avatarColor)}>
      <div className="msg-actions__scrim" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div ref={lift} className="msg-actions__lift" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} aria-hidden />
      {showPicker && (
        <div ref={picker} className={`tapback-picker is-${side}`} role="menu" aria-label="React" style={{ top: rowTop, ...align }} onKeyDown={pickerKeys}>
          {REACTION_KINDS.map((kind, i) => {
            const on = picked ? picked === kind : b.reaction?.kind === kind;
            return (
              <button key={kind} type="button" role="menuitemradio" aria-checked={on} aria-label={REACTION_LABEL[kind].replace(/ at$/, '')}
                className={`tapback-picker__item is-${kind}${on ? ' is-on' : ''}${picked === kind ? ' is-picked' : ''}`}
                style={{ animationDelay: `${i * 35}ms` }} onClick={() => react(kind)}>
                <TapbackGlyph kind={kind} size={18} />
              </button>
            );
          })}
        </div>
      )}
      {mode === 'menu' && (
        <div ref={menu} className="msg-menu" role="menu" aria-label="Message actions" onKeyDown={menuKeys}
          style={menuFlip ? { bottom: Math.max(MARGIN, vh - rect.top + MARGIN + (showPicker && !rowBelow ? ROW_H + MARGIN : 0)), ...align } : { top: menuTop, ...align }}>
          {error && <div className="msg-menu__error" role="alert">{error}</div>}
          {forwarding ? (
            <>
              <button type="button" role="menuitem" className="msg-menu__item is-back" onClick={() => setForwarding(false)}>
                <ChevronLeft size={14} strokeWidth={2} aria-hidden /> Forward to
              </button>
              <div className="msg-menu__sep" role="separator" />
              {targets.length === 0 && <div className="msg-menu__empty">No other Agent can take this.</div>}
              {targets.map((t) => (
                <button key={t.id} type="button" role="menuitem" className="msg-menu__item" onClick={() => forward(t)}>{t.name}</button>
              ))}
            </>
          ) : (
            <>
              {fromAgent && (
                <button type="button" role="menuitem" className="msg-menu__item" onClick={() => picker.current?.querySelector<HTMLElement>('button')?.focus()}>React</button>
              )}
              <button type="button" role="menuitem" className="msg-menu__item" onClick={reply}>Reply</button>
              <button type="button" role="menuitem" className="msg-menu__item" onClick={copy}>Copy</button>
              <div className="msg-menu__sep" role="separator" />
              <button type="button" role="menuitem" className="msg-menu__item" disabled={!b.text.trim()} onClick={() => setForwarding(true)}>Forward to Agent…</button>
              <button type="button" role="menuitem" className="msg-menu__item" onClick={selectText}>Select Text</button>
            </>
          )}
        </div>
      )}
      {mode === 'picker' && error && <div className="msg-menu msg-menu__error is-solo" role="alert" style={{ top: menuTop, ...align }}>{error}</div>}
    </div>,
    document.body,
  );
}
