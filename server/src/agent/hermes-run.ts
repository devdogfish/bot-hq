import { randomUUID } from 'node:crypto';
import type { Engine } from '../engine.js';

export interface ApprovalPrompt {
  promptId: string;
  generation: number;
  command: string;
  description: string;
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

  async approve(prompt: ApprovalPrompt, choice: 'once' | 'deny') {
    if (!this.runId || this.stopRequested) throw new Error('This turn is stopping.');
    const res = await this.request(`/v1/runs/${this.runId}/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: prompt.promptId, execution_generation: prompt.generation, choice }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`Hermes rejected the approval decision (HTTP ${res.status}).`);
  }

  async close(terminal: boolean) {
    // If the stream dropped without a terminal event, ask the gateway to clean up the run.
    if (!terminal && this.runId) await this.sendStop();
    else await this.stopPromise;
    clearTimeout(this.stopTimer);
    this.stream.abort();
  }
}
