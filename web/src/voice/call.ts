// A lightweight voice agent speaks as the bot and relays work to its main text agent (send_task). Results come
// back through the normal transcript stream and are injected into the call as [work_landed] notes.
import { create } from 'zustand';
import type { Row, VoiceSession } from '@shared/types';
import { sortedRows, useStore } from '../store';
import { voiceApi } from './api';
import { connectVoice, type VoiceTransport } from './transport';
import { MicCapture, PcmPlayer, createAudioContext, micErrorMessage, openMic } from './audio';

export interface Caption { id: string; role: 'user' | 'assistant'; text: string; final: boolean }

export type CallStatus = 'idle' | 'connecting' | 'live' | 'ending' | 'error';

interface VoiceState {
  status: CallStatus;
  botId: string | null;
  callId: string | null;
  muted: boolean;
  /** Bot audio is playing. */
  speaking: boolean;
  /** Server VAD hears the user. */
  listening: boolean;
  /** A response is being generated but no audio yet. */
  thinking: boolean;
  /** send_task requests still running in the text agent. */
  working: { seq: number; request: string }[];
  captions: Caption[];
  error: string | null;
  startedAt: number | null;
}

export const useVoice = create<VoiceState>(() => ({
  status: 'idle', botId: null, callId: null, muted: false, speaking: false, listening: false, thinking: false,
  working: [], captions: [], error: null, startedAt: null,
}));

const setV = (p: Partial<VoiceState>) => useVoice.setState(p);

let current: VoiceCall | null = null;

/** Start a call with a bot. Must be called from a user gesture (click) so audio can start. */
export function startCall(botId: string) {
  if (current && !current.ended) {
    if (current.botId === botId) return;
    current.end();
  }
  current = new VoiceCall(botId);
  void current.start();
}

export function endCall() { current?.end(); }
export function toggleMute() { current?.setMuted(!useVoice.getState().muted); }
export function callLevels(): { out: number; mic: number } {
  return current && !current.ended ? { out: current.player.level(), mic: current.micLevel() } : { out: 0, mic: 0 };
}
export const isCallActive = (s: VoiceState = useVoice.getState()) => s.status === 'connecting' || s.status === 'live';

type Json = Record<string, any>;

interface ToolResult { output: string; isError: boolean }

interface PendingTask { seq: number; request: string; since: number; startedBusy: boolean; sawRunning: boolean; awaitingNoted: boolean; doneSince: number | null }

class VoiceCall {
  ended = false;
  readonly ctx: AudioContext;
  readonly player: PcmPlayer;
  private mic: MicCapture | null = null;
  private transport: VoiceTransport | null = null;
  private sess: VoiceSession | null = null;
  private ready = false;
  private responseActive = false;
  private userSpeaking = false;
  private inflight = new Map<string, { name: string; promise: Promise<ToolResult> }>();
  private handledCalls = new Set<string>();
  private tasks: PendingTask[] = [];
  private notes: string[] = [];
  private flushWaiting = false;
  private unsubStore: (() => void) | null = null;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private hangup: ReturnType<typeof setTimeout> | 'draining' | null = null;
  private onUnload = () => { if (this.sess && !this.ended) voiceApi.endBeacon(this.botId, this.sess.callId, this.transcript()); };

  constructor(readonly botId: string) {
    // Created synchronously inside the click so autoplay policy lets it run.
    this.ctx = createAudioContext();
    this.player = new PcmPlayer(this.ctx);
    this.player.onStart = () => setV({ speaking: true, thinking: false });
    this.player.onIdle = () => setV({ speaking: false });
  }

  micLevel() { return useVoice.getState().muted ? 0 : this.mic?.level ?? 0; }

  async start() {
    setV({ status: 'connecting', botId: this.botId, callId: null, muted: false, speaking: false, listening: false, thinking: false, working: [], captions: [], error: null, startedAt: null });
    window.addEventListener('pagehide', this.onUnload);
    let stream: MediaStream;
    try {
      stream = await openMic();
    } catch (e) {
      this.end(micErrorMessage(e));
      return;
    }
    if (this.ended) { stream.getTracks().forEach((t) => t.stop()); return; }
    try {
      this.mic = new MicCapture(this.ctx, stream, (pcm) => this.sendAudio(pcm));
      await this.mic.start();
      if (this.ended) { this.mic.stop(); return; }
      this.sess = await voiceApi.session(this.botId);
      if (this.ended) { void voiceApi.end(this.botId, this.sess.callId, [], 'Cancelled'); return; }
      setV({ callId: this.sess.callId });
      this.connect(this.sess);
    } catch (e) {
      this.end((e as Error).message || 'Could not start the call');
    }
  }

  private connect(sess: VoiceSession) {
    this.transport = connectVoice(sess, {
      ready: () => {
        if (this.ready) return;
        this.ready = true;
        if (this.connectTimer) clearTimeout(this.connectTimer);
        setV({ status: 'live', startedAt: Date.now() });
        this.watchTranscript();
      },
      audio: (pcm, rate) => this.player.push(pcm, rate),
      interrupted: () => { if (this.player.playing) this.player.clear(); },
      speech: (on) => {
        this.userSpeaking = on;
        setV({ listening: on });
        if (!on) this.flushNotes();
      },
      caption: (...args) => this.caption(...args),
      response: (active) => {
        this.responseActive = active;
        setV({ thinking: active });
      },
      tool: (id, name, args, delivery) => {
        if (id && name && this.startTool(id, name, args) && delivery !== 'batch') {
          void this.finishTool(id, delivery === 'reply');
        }
      },
      finishTools: (spoke) => {
        if (this.inflight.size) void this.finishTools(spoke);
        else this.flushNotes();
      },
      settled: () => {
        if (this.hangup) void this.finishHangup();
        else this.flushNotes();
      },
      error: (message) => this.end(message),
      closed: (reason) => {
        if (this.ended) return;
        this.end(this.ready ? 'Call dropped' : `Couldn’t connect the call${reason ? ` (${reason})` : ''}`);
      },
    });
    this.connectTimer = setTimeout(() => { if (!this.ready) this.end('Couldn’t connect the call'); }, 15000);
  }

  private sendAudio(pcm: Int16Array) {
    if (!this.ready || this.ended || useVoice.getState().muted) return;
    this.transport?.sendAudio(pcm);
  }

  setMuted(m: boolean) {
    if (this.mic) this.mic.muted = m;
    if (m && this.ready) this.transport?.clearInput?.();
    setV({ muted: m, listening: m ? false : useVoice.getState().listening });
  }

  private caption(id: string | undefined, role: Caption['role'], text: string, final: boolean, mode: 'set' | 'append') {
    if (!id) return;
    const caps = useVoice.getState().captions;
    const i = caps.findIndex((c) => c.id === id);
    if (i < 0) {
      setV({ captions: [...caps, { id, role, text, final }].slice(-200) });
      return;
    }
    const prev = caps[i];
    const next = { ...prev, text: mode === 'append' ? prev.text + text : text || prev.text, final: final || prev.final };
    const copy = caps.slice();
    copy[i] = next;
    setV({ captions: copy });
  }

  transcript() {
    return useVoice.getState().captions.filter((c) => c.text.trim()).map((c) => ({ role: c.role, text: c.text.trim() }));
  }

  // ---------- relay tools ----------

  private startTool(callId: string, name: string, args: Json) {
    if (this.handledCalls.has(callId)) return false;
    this.handledCalls.add(callId);
    let promise: Promise<ToolResult>;
    if (name === 'end_the_call') promise = Promise.resolve({ output: 'Ending the call.', isError: false });
    else {
      // Show "working" right away; replaced by the real task once the server answers.
      const placeholder = { seq: -1, request: String(args.request ?? '') };
      const dropOptimistic = () => setV({ working: useVoice.getState().working.filter((x) => x !== placeholder) });
      if (name === 'send_task') setV({ working: [...useVoice.getState().working, placeholder] });
      promise = voiceApi.tool(this.botId, this.sess!.callId, name, args)
        .then((r) => {
          if (name === 'send_task' && !this.ended) {
            dropOptimistic();
            if (r.taskSeq) this.addTask(r.taskSeq, String(args.request ?? ''));
          }
          return { output: r.output, isError: false };
        })
        .catch((e) => {
          if (name === 'send_task' && !this.ended) dropOptimistic();
          return { output: `Tool error: ${(e as Error).message}. Tell the user it didn't go through.`, isError: true };
        });
    }
    this.inflight.set(callId, { name, promise });
    return true;
  }

  private async finishTool(id: string, reply: boolean) {
    const tool = this.inflight.get(id)!;
    const { output, isError } = await tool.promise;
    this.inflight.delete(id);
    if (this.ended) return;
    if (tool.name === 'end_the_call') {
      // ElevenLabs can send the farewell after the tool result.
      this.hangup ??= setTimeout(() => { void this.finishHangup(); }, 8000);
    }
    if (reply) this.transport?.sendToolResult(id, output, isError);
    this.flushNotes();
  }

  private async finishHangup() {
    if (!this.hangup || this.hangup === 'draining') return;
    clearTimeout(this.hangup);
    this.hangup = 'draining';
    await this.player.whenIdle(8000);
    this.end();
  }

  private async finishTools(spoke: boolean) {
    const batch = [...this.inflight.entries()];
    this.inflight.clear();
    const outputs = await Promise.all(batch.map(([, b]) => b.promise));
    if (this.ended) return;
    // Every output first, then a single response.create (xAI parallel-call rule).
    batch.forEach(([callId], i) => this.transport?.sendToolResult(callId, outputs[i].output, outputs[i].isError));
    if (batch.some(([, b]) => b.name === 'end_the_call')) {
      await this.player.whenIdle(8000);
      this.end();
      return;
    }
    // A hand-off the bot already announced needs no follow-up turn; read tools do.
    const needsReply = !spoke || batch.some(([, b]) => b.name !== 'send_task');
    if (needsReply) {
      await this.player.whenIdle(8000); // don't talk over the current sentence
      if (!this.ended && !this.responseActive && !this.inflight.size) this.transport?.requestResponse?.();
    } else this.flushNotes();
  }

  // ---------- work_landed: watch the text agent finish what was asked by voice ----------

  private addTask(seq: number, request: string) {
    const live = useStore.getState().live[this.botId];
    this.tasks.push({ seq, request, since: Date.now(), startedBusy: !!live?.isRunning, sawRunning: false, awaitingNoted: false, doneSince: null });
    this.syncWorking();
    this.scheduleCheck(800);
  }

  private syncWorking() {
    const optimistic = useVoice.getState().working.filter((x) => x.seq === -1);
    setV({ working: [...this.tasks.map((t) => ({ seq: t.seq, request: t.request })), ...optimistic] });
  }

  private watchTranscript() {
    this.unsubStore = useStore.subscribe((s, prev) => {
      if (!this.tasks.length) return;
      if (s.live[this.botId] !== prev.live[this.botId] || s.transcripts[this.botId] !== prev.transcripts[this.botId]) {
        if (s.live[this.botId]?.isRunning) for (const t of this.tasks) t.sawRunning = true;
        this.scheduleCheck(400);
      }
    });
  }

  private scheduleCheck(ms: number) {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => this.checkTasks(), ms);
  }

  private checkTasks() {
    if (this.ended || !this.tasks.length) return;
    const st = useStore.getState();
    const live = st.live[this.botId];
    const rows = sortedRows(st.transcripts[this.botId]);
    const now = Date.now();
    let recheck = false;
    for (const task of [...this.tasks]) {
      if (live?.isRunning) task.sawRunning = true;
      const after = rows.filter((r) => r.seq > task.seq);
      if (live?.awaiting) {
        if (!task.awaitingNoted) {
          task.awaitingNoted = true;
          this.queueNote(`The work you handed off ("${clip(task.request, 160)}") is paused and needs ${this.firstName()}'s OK in the chat: ${live.awaiting.reason}. Tell them it's waiting for their approval on screen.`);
        }
        task.doneSince = null;
        continue;
      }
      task.awaitingNoted = false;
      const replies = after.filter((r) => r.body.type === 'message' && r.body.role === 'assistant' && !r.body.streaming);
      const streaming = after.some((r) => r.body.type === 'message' && r.body.streaming);
      const finished = !live?.isRunning && !streaming && (replies.length > 0 || (task.sawRunning && !task.startedBusy));
      if (!finished) { task.doneSince = null; continue; }
      if (now - task.since <= 1500) { recheck = true; continue; }
      // Stay "finished" for a moment: back-to-back queued turns briefly look idle.
      if (task.doneSince === null) { task.doneSince = now; recheck = true; continue; }
      if (now - task.doneSince < 1200) { recheck = true; continue; }
      this.tasks = this.tasks.filter((t) => t !== task);
      this.queueNote(landedNote(task.request, replies, after));
    }
    this.syncWorking();
    if (recheck) this.scheduleCheck(700);
  }

  private firstName() {
    return (useStore.getState().user?.name ?? '').split(/\s+/)[0] || 'the user';
  }

  private queueNote(text: string) {
    this.notes.push(text);
    this.flushNotes();
  }

  private flushNotes() {
    if (!this.ready || this.ended || !this.notes.length) return;
    if (this.responseActive || this.userSpeaking || this.inflight.size || this.hangup) return;
    if (this.player.playing) {
      if (!this.flushWaiting) {
        this.flushWaiting = true;
        void this.player.whenIdle().then(() => { this.flushWaiting = false; this.flushNotes(); });
      }
      return;
    }
    const text = this.notes.splice(0).map((n) => `[work_landed] ${n}`).join('\n\n');
    this.transport?.sendNote(`${text}\n\n(Automatic note from your text agent, not spoken by ${this.firstName()}. Tell them the outcome now, briefly.)`);
  }

  // ---------- teardown ----------

  end(error?: string) {
    if (this.ended) return;
    this.ended = true;
    window.removeEventListener('pagehide', this.onUnload);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.hangup && this.hangup !== 'draining') clearTimeout(this.hangup);
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.unsubStore?.();
    this.transport?.close();
    this.mic?.stop();
    this.player.dispose();
    void this.ctx.close().catch(() => {});
    const transcript = this.transcript();
    if (this.sess) void voiceApi.end(this.botId, this.sess.callId, transcript, error).catch((e) => console.warn('[voice] end failed', e));
    if (current === this) current = null;
    if (error) {
      setV({ status: 'error', error, speaking: false, listening: false, thinking: false, working: [] });
      setTimeout(() => { if (useVoice.getState().status === 'error' && !current) setV({ status: 'idle', botId: null, error: null }); }, 6000);
    } else {
      setV({ status: 'idle', botId: null, callId: null, speaking: false, listening: false, thinking: false, working: [], startedAt: null });
    }
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function landedNote(request: string, replies: Row[], after: Row[]): string {
  const text = replies.map((r) => (r.body.type === 'message' ? r.body.text : '')).join('\n\n').trim();
  const waiting = after
    .map((r) => r.body)
    .filter((b) => b.type === 'card' && b.status === 'pending')
    .map((b) => (b.type === 'card' ? (b.card === 'approval' ? b.title : b.card === 'question' ? `a question: ${b.question}` : b.card === 'connect' ? `connecting ${b.toolkitName}` : b.card === 'secure-input' ? 'secure input via the card. Direct them to the card and keep values out of the call' : 'a draft to review') : ''));
  return `The work you handed off just finished. Request: "${clip(request, 200)}". ${text ? `Your text agent replied:\n"""\n${clip(text, 1800)}\n"""` : 'It finished without a written reply.'}${waiting.length ? `\nStill waiting on the user in the chat: ${waiting.join('; ')}.` : ''}`;
}

/** Play a short TTS sample through the same PCM path the call uses. */
export async function previewVoice(p: { botId: string; voice?: string; speed?: number; language?: string }): Promise<void> {
  const ctx = createAudioContext();
  const player = new PcmPlayer(ctx);
  try {
    const pcm = await voiceApi.preview(p);
    // Feed it in 100 ms chunks, like realtime deltas.
    for (let i = 0; i < pcm.length; i += 2400) player.push(pcm.subarray(i, i + 2400));
    await player.whenIdle(30000);
  } finally {
    player.dispose();
    void ctx.close().catch(() => {});
  }
}
