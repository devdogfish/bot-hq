import { randomUUID } from 'node:crypto';
import type { Engine } from '../engine.js';
import type { ApprovalChoice } from '../types.js';
import { setTimeout as delay } from 'node:timers/promises';

const OWNER_EMAIL_TRANSCRIPT_TOOL = 'mcp__hq__send_owner_email';
const PERSONAL_REPLY_TRANSCRIPT_TOOL = 'mcp__hq__stage_personal_reply';
const PERSONAL_DELETE_TRANSCRIPT_TOOL = 'mcp__hq__stage_personal_delete';
export const SECURE_INPUT_TRANSCRIPT_TOOL = 'mcp__hq__request_secure_input';
const TOOL_WRAPPER_END = '\n</untrusted_tool_result>';
type TranscriptTool = typeof OWNER_EMAIL_TRANSCRIPT_TOOL | typeof PERSONAL_REPLY_TRANSCRIPT_TOOL |
  typeof PERSONAL_DELETE_TRANSCRIPT_TOOL | typeof SECURE_INPUT_TRANSCRIPT_TOOL;

export interface ApprovalPrompt {
  promptId: string;
  generation: number;
  command: string;
  description: string;
  choices: ApprovalChoice[];
  patternKey?: string;
  patternKeys?: string[];
}

export function isApprovalChoice(value: unknown): value is ApprovalChoice {
  return value === 'once' || value === 'session' || value === 'always' || value === 'deny';
}

export class HermesRun {
  readonly stream = new AbortController();
  stopRequested = false;
  stopError: string | undefined;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private stopPromise: Promise<void> | undefined;
  private runId: string | undefined;

  constructor(private engine: Engine) {}

  private request(path: string, options: RequestInit) {
    return fetch(`${this.engine.url}${path}`, {
      ...options,
      redirect: 'error',
      headers: { authorization: `Bearer ${this.engine.key}`, ...options.headers },
    });
  }

  async start(input: Record<string, unknown>, conversation: string) {
    const headers = {
      'content-type': 'application/json',
      'x-hermes-session-key': conversation,
      'idempotency-key': randomUUID(),
    };
    const body = JSON.stringify(input);
    const submit = async () => {
      const response = await this.request('/v1/runs', { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return { status: response.status };
      const receipt: unknown = await response.json();
      const runId = receipt && typeof receipt === 'object' && 'run_id' in receipt ? receipt.run_id : undefined;
      if (typeof runId !== 'string' || !runId) throw new Error('Hermes did not return a run ID.');
      return { runId };
    };
    // Hermes may have admitted the turn before the connection or response body failed.
    const receipt = await submit().catch(() => submit());
    if (!receipt.runId) throw new Error(`Hermes rejected the turn (HTTP ${receipt.status}).`);
    this.runId = encodeURIComponent(receipt.runId);
    if (this.stopRequested) void this.sendStop();
    return this.request(`/v1/runs/${this.runId}/events`, {
      headers: { accept: 'text/event-stream' },
      signal: this.stream.signal,
    });
  }

  stop() {
    this.stopRequested = true;
    if (this.runId) void this.sendStop();
  }

  private sendStop() {
    return this.stopPromise ??= (async () => {
      try {
        const res = await this.request(`/v1/runs/${this.runId}/stop`, {
          method: 'POST', signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.stopTimer = setTimeout(() => {
          this.stopError = 'Hermes has yet to confirm cancellation.';
          this.stream.abort();
        }, 20_000);
      } catch {
        this.stopError = 'Could not send Stop to Hermes.';
        this.stream.abort();
      }
    })();
  }

  async approve(prompt: ApprovalPrompt, choice: ApprovalChoice) {
    if (!this.runId || this.stopRequested) throw new Error('This turn is stopping.');
    if (!prompt.choices.includes(choice)) throw new Error('This approval did not offer that choice.');
    const res = await this.request(`/v1/runs/${this.runId}/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: prompt.promptId, execution_generation: prompt.generation, choice }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`Hermes rejected the approval decision (HTTP ${res.status}).`);
    const receipt = await res.json() as { status?: unknown; prompt_id?: unknown; resolved?: unknown; request_id?: unknown } | null;
    // The session authority can return HTTP 200 when another actor already answered.
    const confirmed = receipt?.status === 'resolved' && receipt.prompt_id === prompt.promptId
      || receipt?.resolved === 1 && receipt.request_id === prompt.promptId;
    if (!confirmed) throw new Error('Hermes did not confirm the approval decision.');
  }

  /** Pinned Hermes can omit a canonical tool result from SSE. Read only this run's latest messages. */
  async toolResult(callId: string, transcriptTool: TranscriptTool = OWNER_EMAIL_TRANSCRIPT_TOOL): Promise<unknown> {
    return (await this.toolResults([callId], transcriptTool)).get(callId);
  }

  async toolResults(callIds: string[], transcriptTool: TranscriptTool) {
    const results = new Map<string, unknown>();
    if (!callIds.length || !this.runId || this.stopRequested) return results;
    const signal = AbortSignal.any([this.stream.signal, AbortSignal.timeout(4000)]);
    try {
      const status = await this.readJson(`/v1/runs/${this.runId}`, signal);
      const session = status?.session_id;
      if (status?.run_id !== decodeURIComponent(this.runId)
          || typeof session !== 'string' || !/^[\w-]{1,150}$/.test(session)) return results;
      const limit = transcriptTool === SECURE_INPUT_TRANSCRIPT_TOOL ? 32 : 8;
      const path = `/api/sessions/${encodeURIComponent(session)}/messages?order=latest&limit=${limit}`;
      const missing = new Set(callIds);
      // The progress callback can precede storage of the corresponding tool row.
      for (let attempt = 0; attempt < 2 && missing.size && !this.stopRequested; attempt++) {
        if (attempt) await delay(150, undefined, { signal });
        const page = await this.readJson(path, signal);
        if (!Array.isArray(page?.data)) break;
        for (const callId of missing) {
          const matches = page.data.filter((row: any) => row?.role === 'tool'
            && typeof row.tool_call_id === 'string' && row.tool_call_id.split('|').some((id: string) => id.trim() === callId));
          if (!matches.length) continue;
          missing.delete(callId);
          if (matches.length === 1 && matches[0].tool_name === transcriptTool) {
            results.set(callId, unwrapToolResult(matches[0].content, transcriptTool));
          }
        }
      }
    } catch { /* A missing or ambiguous result cannot authorize the action. */ }
    return results;
  }

  private async readJson(path: string, signal: AbortSignal): Promise<any> {
    const response = await this.request(path, { signal, headers: { accept: 'application/json' } });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256_000) {
          await reader.cancel();
          return;
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      reader.releaseLock();
    }
  }

  async close(terminal: boolean) {
    // If the stream dropped without a terminal event, ask the gateway to clean up the run.
    if (!terminal && this.runId) await this.sendStop();
    else await this.stopPromise;
    clearTimeout(this.stopTimer);
    this.stream.abort();
  }
}

function unwrapToolResult(content: unknown, transcriptTool: TranscriptTool) {
  if (typeof content !== 'string' || !content.startsWith('<untrusted_tool_result')) return content;
  const start = `<untrusted_tool_result source="${transcriptTool}">\n`;
  if (content.length > 500 || !content.startsWith(start) || !content.endsWith(TOOL_WRAPPER_END)) return;
  // The gateway stores its warning on one line, then a blank line and the original MCP JSON.
  const separator = content.indexOf('\n\n', start.length);
  if (separator < 0 || content.indexOf('\n', start.length) !== separator) return;
  return content.slice(separator + 2, -TOOL_WRAPPER_END.length);
}
