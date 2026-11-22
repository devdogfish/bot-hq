import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Bot } from '@shared/types';
import { api } from '../lib/api';
import { ArrowUp, AudioLines, Mic, Plus, Square } from 'lucide-react';
import { Menu } from './Menu';
import { endCall, isCallActive, startCall, useVoice } from '../voice/call';
import { useDictation } from '../voice/dictation';
import { markSent } from '../lib/sendFlight';
import { playSound } from '../lib/sounds';

const MAX_H = 200;
const drafts = new Map<string, string>();

export function Composer({ bot, running, pausePending }: { bot: Bot; running: boolean; pausePending: boolean }) {
  const [text, setText] = useState(() => drafts.get(bot.id) ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  // One row (+, input, mic, send) until the text wraps; then the input takes its own row until it is cleared.
  const [stacked, setStacked] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const blocked = bot.paused || pausePending;

  // ChatView mounts a composer for the selected bot. Drafts survive switching bots.
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => { drafts.set(bot.id, text); }, [bot.id, text]);

  // Auto-grow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
    el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden';
    // One line is 22px plus the input's padding; anything taller has wrapped.
    if (!text) setStacked(false);
    else if (text.includes('\n') || el.scrollHeight > 40) setStacked(true);
  }, [text, stacked]);

  // Reply from a message's context menu: quote it at the top of the draft, Messages-style, and focus.
  useEffect(() => {
    const quote = (e: Event) => {
      const { botId, text: quoted } = (e as CustomEvent<{ botId: string; text: string }>).detail;
      if (botId !== bot.id) return;
      const block = quoted.trim().split('\n').map((line) => `> ${line}`).join('\n');
      setText((cur) => `${block}\n\n${cur.replace(/^\s+/, '')}`);
      requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
    };
    window.addEventListener('bothq:quote', quote);
    return () => window.removeEventListener('bothq:quote', quote);
  }, [bot.id]);

  // ⌘I focuses the prompt.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const send = async (mode?: 'draft') => {
    const t = text.trim();
    if (!t || sending || blocked) return;
    setSending(true); setError(null);
    try {
      const rect = ref.current?.getBoundingClientRect();
      if (rect) markSent(bot.id, t, rect);
      playSound('send');
      await api.send(bot.id, t, mode);
      if (drafts.get(bot.id) === text) drafts.delete(bot.id);
      setText((current) => current === text ? '' : current);
    } catch (e) {
      setError((e as Error).message || 'Message failed to send');
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const stop = () => api.interrupt(bot.id).catch((e) => setError(e.message));
  const fresh = () => api.fresh(bot.id).catch((e) => setError(e.message));

  // Dictation: insert the transcript at the cursor.
  const insertText = (t: string) => {
    const el = ref.current;
    setText((cur) => {
      const start = el && document.activeElement === el ? el.selectionStart : cur.length;
      const end = el && document.activeElement === el ? el.selectionEnd : cur.length;
      const before = cur.slice(0, start);
      const after = cur.slice(end);
      const pre = before && !/\s$/.test(before) ? ' ' : '';
      const post = after && !/^\s/.test(after) ? ' ' : '';
      requestAnimationFrame(() => { if (el) { const pos = before.length + pre.length + t.length; el.focus(); el.setSelectionRange(pos, pos); } });
      return before + pre + t + post + after;
    });
  };
  const dictation = useDictation(insertText, setError, bot.voiceLanguage, bot.id);
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);

  const hasText = text.trim().length > 0;

  return (
    <div className="composer-area">
      {error && <div className="composer__error">{error} <button type="button" className="link-btn" onClick={() => setError(null)}>Dismiss</button></div>}
      <div className={`composer${stacked ? ' is-stacked' : ''}`}>
        <textarea
          ref={ref}
          className="composer__input"
          rows={1}
          value={text}
          placeholder="Send a message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
          }}
          aria-label={`Message ${bot.name}`}
        />
        <div className="composer__bar">
          <span className="composer__plus-anchor">
            <button type="button" className="composer__btn" onClick={() => setMenu(!menu)} aria-label="More actions" aria-expanded={menu}>
              <Plus size={20} strokeWidth={1.75} aria-hidden />
            </button>
            {menu && (
              <Menu
                placement="above"
                onClose={() => setMenu(false)}
                items={[
                  { label: 'New conversation', onSelect: fresh },
                  ...(inCall ? [] : [{ label: 'Start voice chat', onSelect: () => startCall(bot.id) }]),
                ]}
              />
            )}
          </span>
        <div className="composer__right">
          {bot.draftOnlyAvailable && hasText && (
            <button
              type="button"
              className="composer__chip composer__draft"
              onClick={() => send('draft')}
              disabled={!hasText || sending || blocked}
              title="Draft a text response without tools"
            >
              Draft only
            </button>
          )}
          <button
            type="button"
            className={`composer__btn${dictation.state === 'recording' ? ' is-recording' : dictation.state === 'transcribing' ? ' is-transcribing' : ''}`}
            aria-label={dictation.state === 'recording' ? 'Stop dictation' : 'Dictate'}
            aria-pressed={dictation.state === 'recording'}
            title={dictation.state === 'recording' ? 'Release or click to stop · Esc cancels' : dictation.state === 'transcribing' ? 'Transcribing…' : 'Hold to dictate, or click to start'}
            disabled={dictation.state === 'transcribing'}
            onPointerDown={dictation.onPointerDown}
            onPointerUp={dictation.onPointerUp}
            onKeyDown={dictation.onKeyDown}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Mic size={18} strokeWidth={1.75} aria-hidden />
          </button>
          {inCall && !hasText ? (
            <button type="button" className="composer__cta is-in-call" onClick={endCall} aria-label="End voice call" title="End voice call">
              <AudioLines size={18} strokeWidth={1.75} aria-hidden />
            </button>
          ) : running && !hasText ? (
            <button type="button" className="composer__cta" onClick={stop} aria-label="Stop" title="Stop">
              <Square size={12} strokeWidth={0} fill="currentColor" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              className="composer__cta"
              onClick={() => send()}
              disabled={!hasText || sending || blocked}
              aria-label="Send"
              title="Send (Enter)"
            >
              <ArrowUp size={18} strokeWidth={2.25} aria-hidden />
            </button>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
