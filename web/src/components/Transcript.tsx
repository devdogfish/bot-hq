import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Bot, LiveState, MessageBody, Row, ToolCallBody } from '@shared/types';
import { BotAvatar, BotAvatarFor } from '../avatar/BotAvatar';
import { isWaitingForYou } from '../lib/phrases';
import { clock, dividerLabel, duration } from '../lib/time';
import { useStore } from '../store';
import { takeFlight } from '../lib/sendFlight';
import { CardRow } from './cards/Cards';
import { Icon } from './Icon';
import { Markdown } from './Markdown';

type Item =
  | { kind: 'divider'; key: string; ts: number }
  | { kind: 'group'; key: string; side: 'left' | 'right'; from?: MessageBody['from']; rows: Row[] }
  | { kind: 'steps'; key: string; rows: Row[]; /** Row timestamps just before and just after the run of steps. */ startTs: number | null; endTs: number | null }
  | { kind: 'routine-failures'; key: string; name: string; error: string; count: number }
  | { kind: 'row'; key: string; row: Row };

const DIVIDER_GAP = 60 * 60 * 1000;
const GROUP_GAP = 5 * 60 * 1000;

function routineFailureAt(rows: Row[], index: number) {
  const start = rows[index]?.body;
  if (start?.type !== 'event' || start.event !== 'routine-run' || !start.ref) return;
  const errorRow = rows[index + 1];
  if (errorRow?.seq !== rows[index].seq + 1) return;
  const error = errorRow.body;
  if (error?.type !== 'notice' || error.tone !== 'error') return;
  // Older run errors have no routine ID.
  if (error.routineId === undefined ? !error.text.startsWith('Something went wrong: ') : error.routineId !== start.ref) return;
  return { start, error };
}

/** Turns rows into render items, grouping neighboring messages, steps and repeated routine failures. */
function buildItems(rows: Row[]): Item[] {
  const items: Item[] = [];
  let prevTs = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!prevTs || row.createdAt - prevTs > DIVIDER_GAP) items.push({ kind: 'divider', key: `d${row.seq}`, ts: row.createdAt });
    const before = prevTs;
    prevTs = row.createdAt;
    const last = items[items.length - 1];
    const b = row.body;
    if (b.type === 'tool-call') {
      if (last?.kind === 'steps') last.rows.push(row);
      else items.push({ kind: 'steps', key: `s${row.seq}`, rows: [row], startTs: before || null, endTs: null });
      continue;
    }
    if (last?.kind === 'steps' && last.endTs === null) last.endTs = row.createdAt;
    const failure = routineFailureAt(rows, i);
    if (failure) {
      let next = i + 2;
      for (let pair = routineFailureAt(rows, next); pair; pair = routineFailureAt(rows, next)) {
        if (rows[next].seq !== rows[next - 1].seq + 1) break;
        if (pair.start.ref !== failure.start.ref || pair.start.text !== failure.start.text || pair.error.text !== failure.error.text) break;
        next += 2;
      }
      const count = (next - i) / 2;
      if (count > 1) {
        items.push({
          kind: 'routine-failures', key: `r${row.seq}`, count,
          name: failure.start.text.replace(/^Running routine: /, ''),
          error: failure.error.text.replace(/^Something went wrong: /, ''),
        });
        i = next - 1;
        prevTs = rows[i].createdAt;
        continue;
      }
    }
    if (b.type === 'message') {
      if (!b.text && !b.streaming) continue;
      const side = b.role === 'user' && (!b.from || b.from.kind === 'voice') ? 'right' : 'left';
      const sender = b.from ? `${b.from.kind}:${b.from.id}` : b.role;
      const lastRow = last?.kind === 'group' ? last.rows[last.rows.length - 1] : null;
      const lastBody = lastRow?.body as MessageBody | undefined;
      const lastSender = lastBody ? (lastBody.from ? `${lastBody.from.kind}:${lastBody.from.id}` : lastBody.role) : null;
      if (last?.kind === 'group' && lastSender === sender && row.createdAt - lastRow!.createdAt < GROUP_GAP) last.rows.push(row);
      else items.push({ kind: 'group', key: `g${row.seq}`, side, from: b.from, rows: [row] });
      continue;
    }
    items.push({ kind: 'row', key: `r${row.seq}`, row });
  }
  return items;
}

function cornerClass(i: number, n: number) {
  if (n < 2) return '';
  if (i === 0) return ' is-first';
  if (i === n - 1) return ' is-last';
  return ' is-mid';
}

/** iMessage's send curve: a quick rise that settles softly. */
const FLIGHT_EASING = 'cubic-bezier(0.2, 0.9, 0.3, 1)';
const FLIGHT_MS = 420;

const Bubble = memo(function Bubble({ row, side, pos }: { row: Row; side: 'left' | 'right'; pos: string }) {
  const b = row.body as MessageBody;
  const wrap = useRef<HTMLDivElement>(null);
  // A message just sent from the composer rises from the input into its place.
  useLayoutEffect(() => {
    const el = wrap.current?.firstElementChild as HTMLElement | null;
    if (side !== 'right' || !el || !b.text) return;
    const from = takeFlight(row.botId, b.text);
    if (!from || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const scroller = el.closest('.transcript');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    const to = el.getBoundingClientRect();
    const dx = from.right - to.right;
    const dy = from.bottom - to.bottom;
    if (dy <= 0) return;
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(0.96)`, opacity: 0.6 }, { transform: 'none', opacity: 1 }],
      { duration: FLIGHT_MS, easing: FLIGHT_EASING },
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={wrap} className={`bubble-wrap is-${side}`}>
      <div className={`bubble is-${side === 'right' ? 'user' : 'agent'}${pos}${b.streaming ? ' is-streaming' : ''}`}>
        {b.draftOnly && <span className="bubble__draft">Draft only</span>}
        {side === 'right' || b.draftOnly ? <div className="bubble__plain">{b.text}</div> : <Markdown text={b.text || ' '} />}
        {b.citations && b.citations.length > 0 && (
          <div className="bubble__cites">
            {b.citations.slice(0, 6).map((c, i) => {
              let host = c.url;
              try { host = new URL(c.url).hostname.replace(/^www\./, ''); } catch { /* keep */ }
              return <a key={i} className="cite-chip" href={c.url} target="_blank" rel="noreferrer noopener" title={c.title ?? c.url}>{host}</a>;
            })}
          </div>
        )}
      </div>
      <span className="bubble__time">{clock(row.createdAt)}</span>
    </div>
  );
});

function SenderLabel({ from }: { from: NonNullable<MessageBody['from']> }) {
  const bot = useStore((s) => (from.kind === 'bot' ? s.bots.find((b) => b.id === from.id) : undefined));
  return (
    <div className="sender-label">
      {bot ? <BotAvatarFor bot={bot} size={16} /> : from.kind === 'routine' ? <Icon name="clock" size={12} opacity={0.56} /> : from.kind === 'voice' ? <Icon name="voice_a" size={12} opacity={0.56} /> : <BotAvatar shape="blob" color="gray" size={16} />}
      <span>{from.kind === 'routine' ? `Routine · ${from.name}` : from.kind === 'voice' ? 'Asked on a voice call' : `From ${from.name}`}</span>
    </div>
  );
}

const MAX_WORK_MS = 12 * 60 * 60 * 1000;

/** How long a finished run of steps took, from the row before it to the row after it. */
function workedMs(item: Extract<Item, { kind: 'steps' }>): number | null {
  const end = item.endTs ?? item.rows[item.rows.length - 1].createdAt;
  if (!item.startTs) return null;
  const ms = end - item.startTs;
  return ms >= 1000 && ms < MAX_WORK_MS ? ms : null;
}

function argsText(args: unknown): string | null {
  if (args === undefined || args === null) return null;
  if (typeof args === 'string') return args.trim() ? args.slice(0, 2000) : null;
  if (typeof args === 'object' && Object.keys(args as object).length === 0) return null;
  try {
    const text = JSON.stringify(args, null, 2);
    return text.length > 2000 ? `${text.slice(0, 2000)}\n…` : text;
  } catch { return null; }
}

const STEP_NOTE: Partial<Record<ToolCallBody['status'], string>> = {
  error: 'Failed', denied: 'Not allowed', 'awaiting-approval': 'Waiting for your OK',
};

function StepRow({ call }: { call: ToolCallBody }) {
  const [open, setOpen] = useState(false);
  const args = argsText(call.args);
  const note = STEP_NOTE[call.status];
  const body = (
    <>
      <span className="step__mark" aria-hidden>{call.status === 'running' ? <span className="step__spin" /> : <span className="step__dot" />}</span>
      <span className="step__label">{call.label || call.name}</span>
      {call.summary && <span className="step__summary">{call.summary}</span>}
      {note && <span className="step__note">{note}</span>}
    </>
  );
  return (
    <li className={`step is-${call.status}`}>
      {args ? (
        <button type="button" className="step__row is-clickable" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'Hide details' : 'Show details'}>{body}</button>
      ) : <div className="step__row">{body}</div>}
      {open && args && <pre className="step__args">{args}</pre>}
      {call.screenshot && <img className="step__shot" src={call.screenshot} alt="" />}
    </li>
  );
}

/**
 * A run of tool calls, folded into one chip. While the turn runs it shows what the bot is doing right
 * now and the step count; afterwards it reads "Worked for 2m 10s · 7 steps". Click to see every step.
 */
function Steps({ item, active, open: unfinished, extra, defaultOpen = false }: {
  item: Extract<Item, { kind: 'steps' }>;
  /** The bot is working on this run of steps right now. */
  active: boolean;
  /** The turn this run belongs to has not ended (it may be paused, waiting for the person). */
  open: boolean;
  /** Steps the server has counted that have no row yet. */
  extra: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const calls = item.rows.map((r) => r.body as ToolCallBody);
  const n = calls.length + (unfinished ? extra : 0);
  const count = `${n} ${n === 1 ? 'step' : 'steps'}`;
  const current = [...calls].reverse().find((c) => c.status === 'running') ?? calls[calls.length - 1];
  const worked = unfinished ? null : workedMs(item);
  const flag = calls.some((c) => c.status === 'awaiting-approval') ? 'waiting' : calls.some((c) => c.status === 'error' || c.status === 'denied') ? 'problem' : null;
  return (
    <div className={`steps${open ? ' is-open' : ''}${active ? ' is-active' : ''}`}>
      <button type="button" className="steps__toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {active ? (
          <>
            <span className="step__spin" aria-hidden />
            <span className="steps__now" key={current.callId}>{current.label || current.name}</span>
            <span className="steps__sep" aria-hidden>·</span>
          </>
        ) : (
          <>
            {flag && <span className={`steps__flag is-${flag}`} title={flag === 'waiting' ? 'A step is waiting for your OK' : 'A step did not finish'} />}
            {worked !== null && <><span className="steps__worked">Worked for {duration(worked)}</span><span className="steps__sep" aria-hidden>·</span></>}
          </>
        )}
        <span className="steps__count">{count}</span>
        <Icon name="chev_right" size={10} opacity={0.66} className="steps__chev" />
      </button>
      {open && <ul className="steps__list">{calls.map((c) => <StepRow key={c.callId} call={c} />)}</ul>}
    </div>
  );
}

function SystemRow({ row }: { row: Row }) {
  const b = row.body;
  if (b.type === 'event') return <div className="system-event">{b.text}</div>;
  if (b.type === 'notice') return <div className={`notice is-${b.tone ?? 'info'}`}>{b.text}</div>;
  if (b.type === 'card') return <CardRow row={row} />;
  return null;
}

interface Props { bot: Bot; rows: Row[]; loaded: boolean }

export function Transcript({ bot, rows, loaded }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const items = useMemo(() => buildItems(rows), [rows]);

  // Keep pinned to the bottom while new content arrives, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  // Jump to bottom when switching bots.
  useLayoutEffect(() => {
    stick.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bot.id]);

  const onScroll = () => {
    const el = scrollRef.current!;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = dist < 40;
    setShowJump(dist > 200);
  };

  const jump = () => {
    const el = scrollRef.current!;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div className="transcript-wrap">
    <div className="transcript" ref={scrollRef} onScroll={onScroll}>
      <div className="transcript__col">
        {loaded && rows.length === 0 && <EmptyChat bot={bot} />}
        {items.map((it) => {
          switch (it.kind) {
            case 'divider':
              return <div key={it.key} className="divider">{dividerLabel(it.ts)}</div>;
            case 'steps':
              return null; // Steps live behind the header (StepsHistory), not in the chat.
            case 'row':
              return <SystemRow key={it.key} row={it.row} />;
            case 'routine-failures':
              return <div key={it.key} className="notice is-error">{it.name} failed ×{it.count} · {it.error}</div>;
            case 'group':
              return (
                <div key={it.key} className={`group is-${it.side}`}>
                  {it.from && <SenderLabel from={it.from} />}
                  {it.rows.map((r, i) => (
                    <Fragment key={r.seq}><Bubble row={r} side={it.side} pos={cornerClass(i, it.rows.length)} /></Fragment>
                  ))}
                </div>
              );
          }
        })}
      </div>
    </div>
      {showJump && (
        <button type="button" className="jump-btn" onClick={jump} aria-label="Scroll to bottom">
          <Icon name="arrow_down" size={16} />
        </button>
      )}
    </div>
  );
}

function EmptyChat({ bot }: { bot: Bot }) {
  return (
    <div className="empty-chat">
      <BotAvatarFor bot={bot} size={72} />
      <div className="empty-chat__title">{bot.name}</div>
      <div className="empty-chat__sub">{bot.description || (bot.mode === 'teammate' ? 'A Bot for the whole team. Hand it a task and it will see it through.' : 'Your personal assistant. Hand it a task and it will see it through.')}</div>
    </div>
  );
}

/**
 * Every run of tool calls in this conversation, newest first, for the header's steps popover. The run
 * still growing while the turn works shows what the Agent is doing now.
 */
export function StepsHistory({ rows, live }: { rows: Row[]; live: LiveState | undefined }) {
  const items = useMemo(() => buildItems(rows), [rows]);
  const runs = items.filter((it): it is Extract<Item, { kind: 'steps' }> => it.kind === 'steps');
  const running = !!live?.isRunning;
  const waiting = isWaitingForYou(live);
  const lastItem = items[items.length - 1];
  const openKey = (running || waiting) && lastItem?.kind === 'steps' ? lastItem.key : null;
  const activeKey = running && !waiting ? openKey : null;
  const turnSteps = useMemo(() => {
    let n = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const b = rows[i].body;
      if (b.type === 'message' && b.role === 'user') break;
      if (b.type === 'tool-call') n++;
    }
    return n;
  }, [rows]);
  const extra = Math.max(0, (running ? live?.steps ?? 0 : 0) - turnSteps);
  if (runs.length === 0) return <div className="steps-history__empty">No steps yet in this conversation.</div>;
  return (
    <div className="steps-history">
      {[...runs].reverse().map((it, i) => (
        <Steps key={it.key} item={it} active={it.key === activeKey} open={it.key === openKey} extra={extra} defaultOpen={i === 0} />
      ))}
    </div>
  );
}
