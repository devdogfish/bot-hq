import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { appendRow, emitBot, getBotRow, getLive, getRow, setLive, updateRow } from '../store.js';
import type { ActivityKind, MessageBody, ToolCallBody } from '../types.js';
import { engineFor } from '../engine.js';
import { HermesRun, type ApprovalPrompt } from './hermes-run.js';
import { instructionsFor } from './prompt.js';
import { activityFor, appToolName } from './tools.js';

/**
 * A turn: one message handed to the bot's Hermes engine and streamed back into the conversation.
 *
 * Hermes owns the agent loop, the history and the tools. This file only
 *  - queues turns so a bot handles one at a time,
 *  - posts the trigger to Hermes and turns the event stream into
 *    rows (assistant messages, tool calls) and live state (what the bot is doing right now),
 *  - keeps the bookkeeping the app's own tools need while a turn runs (see mcp.ts): which tool-call
 *    row a call belongs to, and approvals the user has to answer before a call goes ahead.
 */

export type Trigger =
  | { type: 'user'; text: string }
  | { type: 'routine'; routineId: string; name: string; prompt: string }
  | { type: 'bot'; fromBotId: string; fromName: string; text: string; depth: number }
  | { type: 'system'; text: string };

// ---------- per-bot serial queue ----------

interface BotQueue {
  tail: Promise<void>;
  revision: number;
  resetting: boolean;
}

const queues = new Map<string, BotQueue>();
const aborts = new Map<string, AbortController>();
const remoteRuns = new Map<string, HermesRun>();

function queueFor(botId: string): BotQueue {
  const existing = queues.get(botId);
  if (existing) return existing;
  const queue = { tail: Promise.resolve(), revision: 0, resetting: false };
  queues.set(botId, queue);
  return queue;
}

function trackQueue(botId: string, queue: BotQueue, tail: Promise<void>) {
  queue.tail = tail;
  void tail.then(() => { if (queue.tail === tail) queues.delete(botId); });
}

/** Reserve a turn synchronously; accepted work starts after the caller records its row. */
export function enqueue(botId: string, trigger: Trigger) {
  const queue = queueFor(botId);
  if (queue.resetting) return false;
  // A new message from the user supersedes an unanswered approval.
  if (trigger.type === 'user') expireApprovals(botId);
  const revision = queue.revision;
  const next = queue.tail.then(() => {
    if (queue.revision === revision) return runTurn(botId, trigger);
  }).catch((e) => console.error('[agent] turn failed', botId, e));
  trackQueue(botId, queue, next);
  return true;
}

export type EnqueueTurn = typeof enqueue;

export function interrupt(botId: string) {
  expireApprovals(botId);
  const run = remoteRuns.get(botId);
  if (run) run.stop();
  else aborts.get(botId)?.abort();
}

/** Discard queued turns, stop the active turn and run maintenance before accepting more work. */
export async function resetBotQueue(botId: string, job: () => void | Promise<void>) {
  const queue = queueFor(botId);
  if (queue.resetting) return false;
  queue.resetting = true;
  queue.revision++;
  interrupt(botId);
  const result = queue.tail.then(job);
  trackQueue(botId, queue, result.then(() => {}, () => {}));
  try {
    await result;
    return true;
  } finally {
    queue.resetting = false;
  }
}

export const isBotBusy = (botId: string) => queues.has(botId);
export const isBotResetting = (botId: string) => queues.get(botId)?.resetting === true;

export function enqueueBotMessage(fromBotId: string, toBotId: string, text: string, depth: number) {
  const from = getBotRow(fromBotId);
  if (!enqueue(toBotId, { type: 'bot', fromBotId, fromName: from.name, text, depth })) return false;
  appendRow(toBotId, 'message', { type: 'message', role: 'user', text, from: { kind: 'bot', id: fromBotId, name: from.name } });
  return true;
}

function triggerText(t: Trigger): string {
  switch (t.type) {
    case 'user': return t.text;
    case 'routine': return `[Routine "${t.name}" is running now. Do this:]\n${t.prompt}`;
    case 'bot': return `[Message from ${t.fromName}, another Bot on the team. Reply to them with send_to_bot if they asked you something.]\n${t.text}`;
    case 'system': return `[System notice] ${t.text}`;
  }
}

// ---------- the running turn, as the app's tools see it ----------

interface ToolRef { seq: number; callId: string; name: string; claimed: boolean; done: boolean }
interface Outcome { status?: ToolCallBody['status']; summary?: string }

interface Turn {
  botId: string;
  userId: string;
  /** How many bot-to-bot hops led here (send_to_bot stops a ping-pong at 3). */
  depth: number;
  /** A tool ended the conversation for now (asked the user, stayed silent): drop any closing text. */
  silent: boolean;
  tools: ToolRef[];
  /** What an app tool said about its own call; beats what we would guess from the raw output. */
  outcomes: Map<number, Outcome>;
}

const turns = new Map<string, Turn>();

export const turnDepth = (botId: string) => turns.get(botId)?.depth ?? 0;

export function markSilent(botId: string) {
  const t = turns.get(botId);
  if (t) t.silent = true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * An app tool was called through MCP: find the tool-call row the event stream made for it.
 * The stream announces a call just before the engine runs it, so wait a moment for the row.
 * Returns null when the call did not come from a turn started here (e.g. the agent used the tool
 * while talking to its owner somewhere else).
 */
export async function claimToolRow(botId: string, name: string): Promise<number | null> {
  const deadline = Date.now() + 600;
  for (;;) {
    const t = turns.get(botId);
    if (!t) return null;
    const ref = t.tools.find((r) => !r.claimed && !r.done && r.name === name);
    if (ref) { ref.claimed = true; return ref.seq; }
    if (Date.now() > deadline) return null;
    await sleep(40);
  }
}

export function noteToolOutcome(botId: string, seq: number | null, outcome: Outcome) {
  if (seq === null) return;
  turns.get(botId)?.outcomes.set(seq, outcome);
  patchToolRow(botId, seq, outcome);
}

function patchToolRow(botId: string, seq: number, patch: Partial<ToolCallBody>) {
  const row = getRow(botId, seq);
  if (row && row.body.type === 'tool-call') updateRow(botId, seq, { ...row.body, ...patch });
}

// ---------- approvals ----------

type ApprovalDecision = 'allow' | 'deny' | 'expired' | 'unconfirmed';

/** Longest a tool call waits for the user. Kept under the engines' 30 minute tool timeout. */
const APPROVAL_WAIT_MS = 25 * 60_000;

const waiters = new Map<string, {
  resolve: (decision: ApprovalDecision) => void;
  send: (choice: 'once' | 'deny') => Promise<void>;
  sending?: Promise<void>;
  expireAfterSend?: boolean;
}>();

function setApprovalCard(botId: string, rowSeq: number, approvalId: string, status: string) {
  const card = getRow(botId, rowSeq);
  if (card && card.body.type === 'card' && card.body.card === 'approval' && card.body.approvalId === approvalId) {
    updateRow(botId, rowSeq, { ...card.body, status } as any);
  }
}

const pendingApprovals = (botId: string) => db.prepare("SELECT * FROM approvals WHERE bot_id=? AND status='pending'").all(botId) as any[];

/** Put an approval card in the conversation and wait for the user's answer. */
async function requestApproval(
  who: { userId: string; botId: string },
  prompt: ApprovalPrompt,
  send: (choice: 'once' | 'deny') => Promise<void>,
  rowSeq: number | null,
): Promise<ApprovalDecision> {
  const { userId, botId } = who;
  const approvalId = newId('apr');
  const card = appendRow(botId, 'card', {
    type: 'card', card: 'approval', approvalId, title: `Allow ${getBotRow(botId).name} to perform this action?`,
    detail: [prompt.description, prompt.command].filter(Boolean).join('\n'), tool: 'Hermes approval', args: {}, status: 'pending',
  });
  db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES (?,?,?,?,?,?,?)').run(approvalId, botId, card.seq, '', 'hermes', 'pending', now());
  db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(botId);
  if (rowSeq !== null) patchToolRow(botId, rowSeq, { status: 'awaiting-approval' });
  setLive(botId, { isRunning: true, activity: { kind: 'waiting_for_you', since: now() }, awaiting: { reason: 'Hermes approval', since: now() } });
  hub.emit(userId, { type: 'tasks', botId });
  emitBot(botId);

  let timer: NodeJS.Timeout | undefined;
  const decision = await new Promise<ApprovalDecision>((resolve) => {
    waiters.set(approvalId, { resolve, send });
    timer = setTimeout(() => expireApproval(approvalId), APPROVAL_WAIT_MS);
  });
  clearTimeout(timer);
  waiters.delete(approvalId);

  if (rowSeq !== null) {
    if (decision === 'allow') {
      const row = getRow(botId, rowSeq);
      if (row?.body.type === 'tool-call' && row.body.status === 'awaiting-approval') {
        patchToolRow(botId, rowSeq, { status: 'running' });
      }
    } else if (decision !== 'unconfirmed') {
      noteToolOutcome(botId, rowSeq, { status: 'denied', summary: decision === 'deny' ? 'Not allowed' : 'Skipped' });
    }
  }
  if (!pendingApprovals(botId).length) {
    if (turns.has(botId)) setLive(botId, { isRunning: true, activity: { kind: 'thinking', since: now() }, awaiting: null });
    else setLive(botId, { isRunning: false, activity: null, awaiting: null, startedAt: null });
  }
  hub.emit(userId, { type: 'tasks', botId });
  return decision;
}

function finishApproval(ap: { id: string; bot_id: string; row_seq: number }, decision: ApprovalDecision) {
  const status = decision === 'allow' ? 'allowed' : decision === 'deny' ? 'denied' : decision;
  db.prepare("UPDATE approvals SET status=?, resolved_at=? WHERE id=? AND status='pending'").run(status, now(), ap.id);
  setApprovalCard(ap.bot_id, ap.row_seq, ap.id, status);
  waiters.get(ap.id)?.resolve(decision);
}

function expireApproval(approvalId: string) {
  const waiter = waiters.get(approvalId);
  // An accepted decision can finish the run before Hermes's HTTP acknowledgement arrives.
  if (waiter?.sending) {
    waiter.expireAfterSend = true;
    return;
  }
  const ap = db.prepare("SELECT * FROM approvals WHERE id=? AND status='pending'").get(approvalId) as any;
  if (ap) finishApproval(ap, 'expired');
}

export function expireApprovals(botId: string) {
  for (const ap of pendingApprovals(botId)) expireApproval(ap.id);
}

/** After a restart nothing is waiting on old approval cards any more. */
export function expireStaleApprovals() {
  for (const ap of db.prepare("SELECT id FROM approvals WHERE status='pending'").all() as any[]) expireApproval(ap.id);
}

/** Resolve an approval card from the UI. */
export async function resolveApproval(userId: string, approvalId: string, decision: 'allow' | 'deny') {
  const ap = db.prepare('SELECT a.*, b.user_id FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE a.id=?').get(approvalId) as any;
  if (!ap || ap.user_id !== userId) return 'not found';
  if (ap.status !== 'pending') return null;
  const waiter = waiters.get(approvalId);
  if (!waiter) { expireApproval(approvalId); return null; }
  if (waiter.sending) return 'Approval decision is already being sent.';
  try {
    waiter.sending = waiter.send(decision === 'allow' ? 'once' : 'deny');
    await waiter.sending;
    finishApproval(ap, decision);
    return null;
  } catch (e: any) {
    if (waiter.expireAfterSend) finishApproval(ap, 'unconfirmed');
    return String(e?.message ?? e);
  } finally {
    waiter.sending = undefined;
  }
}

// ---------- the engine's event stream ----------

interface StreamEvent { type: string; data: any }

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body as any as AsyncIterable<Uint8Array>) {
    buf = (buf + dec.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, end);
      buf = buf.slice(end + 2);
      let event = '';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue; // a keepalive comment
      const raw = data.join('\n');
      if (raw === '[DONE]') continue;
      try {
        const json = JSON.parse(raw);
        yield { type: event || json?.type || json?.event || '', data: json };
      } catch { /* not ours to understand */ }
    }
  }
}

function normalizeRunEvent(ev: StreamEvent): StreamEvent {
  const d = ev.data;
  switch (ev.type) {
    case 'message.delta':
      return { type: 'response.output_text.delta', data: d };
    case 'message.interim':
      return d.already_streamed ? ev : { type: 'response.output_item.done', data: {
        item: { type: 'message', phase: 'commentary', content: [{ text: d.text }] },
      } };
    case 'tool.started':
      return { type: 'response.output_item.added', data: {
        item: { type: 'function_call', name: d.tool, call_id: d.tool_call_id, arguments: { preview: d.preview } },
      } };
    case 'tool.completed':
      return { type: 'response.output_item.done', data: {
        item: { type: 'function_call_output', call_id: d.tool_call_id, output: d.error ? 'Tool error: ' + (d.preview ?? '') : d.preview },
      } };
    default:
      return ev;
  }
}

async function failureText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  try {
    const j = JSON.parse(raw);
    const m = j?.error?.message ?? j?.message ?? j?.error;
    if (typeof m === 'string' && m) return m;
  } catch { /* plain text */ }
  if (res.status === 401 || res.status === 403) return 'the engine did not accept our key';
  return raw.slice(0, 300) || `the engine answered ${res.status}`;
}

/** What a tool's raw result says about how it went. */
function readOutcome(item: any): Outcome {
  const text = Array.isArray(item?.output) ? item.output.map((p: any) => p?.text ?? '').join('') : String(item?.output ?? '');
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') {
      if (j.error) return { status: 'error', summary: String(typeof j.error === 'string' ? j.error : JSON.stringify(j.error)).slice(0, 200) };
      if (typeof j.exit_code === 'number' && j.exit_code !== 0) return { status: 'error', summary: `Exit code ${j.exit_code}` };
      if (j.success === false) return { status: 'error', summary: String(j.message ?? 'Failed').slice(0, 200) };
    }
  } catch { /* not JSON */ }
  if (/^(tool )?error\b/i.test(text.trim())) return { status: 'error', summary: text.trim().slice(0, 200) };
  return { status: 'done' };
}

/** A short line for the "thinking" chip out of the model's running reasoning. */
function captionFrom(reasoning: string): string | null {
  const titles = [...reasoning.matchAll(/\*\*([^*\n]{3,80})\*\*/g)];
  if (titles.length) return titles[titles.length - 1][1].trim();
  const para = reasoning.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).pop();
  if (!para) return null;
  const sentence = para.split(/(?<=[.!?])\s/)[0].replace(/\s+/g, ' ').trim();
  if (sentence.length < 4) return null;
  return sentence.length > 84 ? `${sentence.slice(0, 81).trimEnd()}…` : sentence;
}

// ---------- the turn ----------

/** Hermes' own tool lookup (it loads rarely used tools on demand). */
const TOOLBOX = new Set(['tool_search', 'tool_describe']);

async function runTurn(botId: string, trigger: Trigger) {
  const bot = getBotRow(botId);
  if (!bot || bot.kind === 'room') return;
  const userId: string = bot.user_id;
  const ctrl = new AbortController();
  aborts.set(botId, ctrl);
  const turn: Turn = { botId, userId, depth: trigger.type === 'bot' ? trigger.depth : 0, silent: false, tools: [], outcomes: new Map() };
  turns.set(botId, turn);
  setLive(botId, { isRunning: true, activity: { kind: 'thinking', since: now() }, awaiting: null, startedAt: now(), caption: null, steps: 0 });

  // The assistant message being written right now.
  let msgSeq: number | null = null;
  let text = '';
  let lastFlush = 0;
  let wroteText = false;
  const flush = (streaming: boolean) => {
    const b: MessageBody = { type: 'message', role: 'assistant', text, streaming };
    if (msgSeq === null) msgSeq = appendRow(botId, 'message', b).seq;
    else updateRow(botId, msgSeq, b);
    lastFlush = Date.now();
  };
  const closeMessage = () => {
    if (msgSeq === null) return;
    if (text.trim()) {
      flush(false);
      db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(botId);
    } else updateRow(botId, msgSeq, { type: 'message', role: 'assistant', text: '', streaming: false });
    msgSeq = null;
    text = '';
  };
  const say = (t: string) => {
    if (turn.silent || !t.trim()) return;
    closeMessage();
    appendRow(botId, 'message', { type: 'message', role: 'assistant', text: t.trim(), streaming: false });
    db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(botId);
    wroteText = true;
  };

  let reasoning = '';
  let lastCaption = 0;
  const caption = (c: string | null, force = false) => {
    if (!c || c === getLive(botId).caption) return;
    if (!force && Date.now() - lastCaption < 300) return;
    lastCaption = Date.now();
    setLive(botId, { caption: c });
  };
  const outputsSeen = new Set<string>();
  let steps = 0;
  let failed = false;
  let cancelled = false;
  let terminal = false;
  let remote: HermesRun | undefined;
  const approvals = new Map<string, Promise<void>>();

  try {
    const engine = await engineFor(botId);
    if (ctrl.signal.aborted) throw new Error('interrupted');

    let input = triggerText(trigger);
    if (bot.handback_at) {
      input = `[Note: the user took control of your screen for a while and has just handed it back. Look at the screen before you rely on what was there.]\n\n${input}`;
      db.prepare('UPDATE bots SET handback_at=NULL WHERE id=?').run(botId);
    }

    const payload = {
      model: bot.model || 'hermes-agent',
      ...(bot.provider ? { provider: bot.provider } : {}),
      input,
      instructions: await instructionsFor(userId, botId),
      model_options: { reasoning_effort: bot.effort ?? 'medium' },
    };
    if (ctrl.signal.aborted) throw new Error('interrupted');
    // A fresh chat increments the generation. Keep the gateway's conversation stable until then.
    const conversation = `hq-${botId}-g${bot.generation}`;
    let res: Response;
    if (engine.kind === 'remote') {
      remote = new HermesRun(engine);
      remoteRuns.set(botId, remote);
      res = await remote.start(payload, conversation);
    } else {
      res = await fetch(`${engine.url}/v1/responses`, {
        method: 'POST', signal: ctrl.signal, redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(engine.key ? { authorization: `Bearer ${engine.key}` } : {}) },
        body: JSON.stringify({ ...payload, conversation, stream: true, store: true }),
      });
    }
    if (!res.ok || !res.body) throw new Error(await failureText(res));

    for await (const raw of sseEvents(res.body)) {
      const ev = remote ? normalizeRunEvent(raw) : raw;
      const d = ev.data;
      switch (ev.type) {
        case 'response.output_text.delta': {
          if (turn.silent || typeof d.delta !== 'string') break;
          // Models often open with blank lines; a message never starts with them.
          const piece = text ? d.delta : d.delta.trimStart();
          if (!piece) break;
          text += piece;
          wroteText = true;
          if (msgSeq === null) setLive(botId, { activity: { kind: 'working', since: now() } });
          if (msgSeq === null || Date.now() - lastFlush > 120) flush(true);
          break;
        }

        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          if (typeof d.delta === 'string') {
            reasoning = (reasoning + d.delta).slice(-4000);
            caption(captionFrom(reasoning));
          }
          break;
        }

        case 'hermes.status': {
          if (typeof d?.text === 'string' && d.text.trim()) caption(d.text.trim().slice(0, 84), true);
          break;
        }

        case 'response.output_item.added': {
          const item = d.item;
          if (item?.type === 'reasoning') {
            reasoning = '';
            if (getLive(botId).activity?.kind !== 'thinking') setLive(botId, { activity: { kind: 'thinking', since: now() } });
          }
          if (item?.type === 'function_call') {
            // Text written before this call is its own message; what follows starts a new one.
            closeMessage();
            const { name, ours } = appToolName(String(item.name ?? ''));
            // The agent looking through its own toolbox is not a step worth showing.
            if (!ours && TOOLBOX.has(name)) {
              caption('Finding the right tool', true);
              break;
            }
            const act = activityFor(String(item.name ?? ''));
            let args: any;
            try { args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments; } catch { args = undefined; }
            const row = appendRow(botId, 'tool-call', { type: 'tool-call', callId: String(item.call_id ?? item.id ?? ''), name, label: act.label, status: 'running', args } satisfies ToolCallBody);
            turn.tools.push({ seq: row.seq, callId: String(item.call_id ?? item.id ?? ''), name, claimed: false, done: false });
            steps++;
            const kind: ActivityKind = name === 'send_to_bot' ? 'messaging_named' : act.kind;
            const detail = name === 'send_to_bot' ? String(args?.bot_name ?? '') || undefined : act.detail;
            // A call that is waiting for the user keeps its "waiting for you" state.
            if (!getLive(botId).awaiting) setLive(botId, { isRunning: true, activity: { kind, detail, since: now() }, steps, caption: null });
            else setLive(botId, { steps });
            reasoning = '';
          }
          break;
        }

        case 'response.output_item.done': {
          const item = d.item;
          if (item?.type === 'message') {
            const full = (item.content ?? []).map((c: any) => c?.text ?? '').join('');
            if (item.phase === 'commentary') say(full);
            else if (msgSeq !== null) closeMessage();
            else if (!wroteText) say(full);
          }
          break;
        }

        case 'approval.request': {
          if (!remote || remote.stopRequested) break;
          const run = remote;
          const prompt: ApprovalPrompt = {
            promptId: d.prompt_id, generation: d.execution_generation,
            command: typeof d.command === 'string' ? d.command : '',
            description: typeof d.description === 'string' ? d.description : '',
          };
          if (typeof prompt.promptId !== 'string' || !Number.isInteger(prompt.generation)) {
            throw new Error('Hermes returned an approval without its prompt identity.');
          }
          if (approvals.has(prompt.promptId)) break;
          const tool = turn.tools.findLast((ref) => !ref.done && ref.name === 'terminal');
          const send = (choice: 'once' | 'deny') => run.approve(prompt, choice);
          const decide = async () => {
            if (trigger.type !== 'user') {
              await send('deny');
              appendRow(botId, 'notice', { type: 'notice', text: 'Hermes requested approval during an unattended turn. The command was denied.', tone: 'info' });
              return;
            }
            const decision = await requestApproval({ userId, botId }, prompt, send, tool?.seq ?? null);
            if (terminal || run.stopRequested) return;
            if (decision === 'expired') await send('deny');
            if (decision === 'unconfirmed') run.stop();
          };
          approvals.set(prompt.promptId, decide().catch(() => {
            if (!run.stopRequested) {
              appendRow(botId, 'notice', { type: 'notice', text: 'Could not resolve the Hermes approval. Stopping the turn.', tone: 'error' });
              run.stop();
            }
          }));
          break;
        }

        case 'run.completed':
        case 'run.incomplete':
          terminal = true;
          if (!wroteText && typeof d.output === 'string') say(d.output);
          break;

        case 'run.cancelled':
        case 'response.cancelled':
          terminal = true;
          cancelled = true;
          throw new Error('interrupted');

        case 'run.failed':
        case 'run.interrupted':
          terminal = true;
          throw new Error(d.error ?? 'Hermes did not complete the turn.');

        case 'response.failed':
        case 'error':
          throw new Error(d?.response?.error?.message ?? d?.error?.message ?? d?.message ?? 'the agent run failed');
      }

      // A tool result arrives as an item of its own (announced twice: added and done).
      const item = d?.item;
      if (item?.type === 'function_call_output' && item.call_id && !outputsSeen.has(item.call_id)) {
        outputsSeen.add(item.call_id);
        const ref = turn.tools.find((r) => r.callId === item.call_id);
        if (ref) {
          ref.done = true;
          const told = turn.outcomes.get(ref.seq);
          const guess = readOutcome(item);
          patchToolRow(botId, ref.seq, told?.status && told.status !== 'running' ? told : { status: guess.status, summary: told?.summary ?? guess.summary });
          if (!getLive(botId).awaiting) setLive(botId, { activity: { kind: 'thinking', since: now() } });
        }
      }
    }
    if (remote && !terminal) throw new Error('Hermes closed the stream without a final run status.');
  } catch (e: any) {
    failed = true;
    const stopped = ctrl.signal.aborted || cancelled;
    closeMessage();
    appendRow(botId, 'notice', { type: 'notice', text: stopped ? 'Stopped.' : `Something went wrong: ${remote?.stopError ?? e?.message ?? e}`, tone: stopped ? 'info' : 'error' });
    if (!stopped) console.error('[agent]', botId, e);
  } finally {
    if (remote) {
      expireApprovals(botId);
      if (!terminal) remote.stop();
      await remote.close(terminal);
      await Promise.all(approvals.values());
      remoteRuns.delete(botId);
    }
    closeMessage();
    for (const ref of turn.tools) {
      if (ref.done) continue;
      const row = getRow(botId, ref.seq);
      if (row?.body.type !== 'tool-call' || (row.body.status !== 'running' && row.body.status !== 'awaiting-approval')) continue;
      patchToolRow(botId, ref.seq, failed ? { status: 'error', summary: ctrl.signal.aborted || cancelled ? 'Stopped' : 'Did not finish' } : { status: 'done' });
    }
    if (aborts.get(botId) === ctrl) aborts.delete(botId);
    if (turns.get(botId) === turn) turns.delete(botId);
    // An approval asked for outside this turn may still be waiting; leave its state alone.
    if (!pendingApprovals(botId).length) setLive(botId, { isRunning: false, activity: null, awaiting: null, startedAt: null, caption: null });
    else setLive(botId, { isRunning: false, caption: null });
    emitBot(botId);
  }
}
