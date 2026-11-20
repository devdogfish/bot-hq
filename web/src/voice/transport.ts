import type { VoiceSession } from '@shared/types';
import { base64ToPcm, pcmToBase64, RATE, resamplePcm } from './audio';

type Json = Record<string, any>;
type ToolDelivery = 'batch' | 'reply' | 'no-reply';

interface CallEvents {
  ready(): void;
  audio(pcm: Int16Array, rate: number): void;
  interrupted(): void;
  speech(on: boolean): void;
  caption(id: string | undefined, role: 'user' | 'assistant', text: string, final: boolean, mode: 'set' | 'append'): void;
  response(active: boolean): void;
  tool(callId: string | undefined, name: string | undefined, args: Json, delivery: ToolDelivery): void;
  finishTools(spoke: boolean): void;
  settled(): void;
  error(message: string): void;
  closed(reason: string): void;
}

export interface VoiceTransport {
  sendAudio(pcm: Int16Array): void;
  clearInput?(): void;
  sendToolResult(callId: string, output: string, isError: boolean): void;
  requestResponse?(): void;
  sendNote(text: string): void;
  close(): void;
}

function socket(url: string, init: Json, handle: (ev: Json) => void, closed: CallEvents['closed'], protocol?: string) {
  const ws = protocol ? new WebSocket(url, [protocol]) : new WebSocket(url);
  const send = (ev: Json) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
  };
  ws.onopen = () => send(init);
  ws.onmessage = (message) => {
    if (typeof message.data !== 'string') return;
    try { handle(JSON.parse(message.data)); } catch (e) { console.warn('[voice] bad event', e); }
  };
  ws.onclose = (e) => closed(e.reason);
  return {
    send,
    close() {
      ws.onmessage = null;
      try { ws.close(1000, 'call ended'); } catch { /* ignore */ }
    },
  };
}

function decodeArgs(raw: unknown): Json {
  if (typeof raw !== 'string') return {};
  try { return JSON.parse(raw) ?? {}; } catch { return {}; }
}

const NOTE_CUE = 'Automatic cue from your text agent. Tell the caller the latest [work_landed] outcome now, briefly.';

function pcmRate(format: unknown): number | undefined {
  if (typeof format !== 'string' || !/^pcm_(8000|16000|22050|24000|44100|48000)$/.test(format)) return;
  return Number(format.slice(4));
}

function connectElevenLabs(session: Extract<VoiceSession, { provider: 'elevenlabs' }>, events: CallEvents): VoiceTransport {
  let inputRate = RATE;
  let outputRate = RATE;
  let interruptionId = -1;
  let lastAgentCaption: string | undefined;
  let captionCount = 0;
  const { send, close } = socket(session.signedUrl, session.initData, (ev) => {
    switch (ev.type) {
      case 'conversation_initiation_metadata': {
        const metadata = ev.conversation_initiation_metadata_event;
        const input = pcmRate(metadata?.user_input_audio_format);
        const output = pcmRate(metadata?.agent_output_audio_format);
        if (!input || !output) { events.error('Unsupported ElevenLabs audio format'); return; }
        inputRate = input;
        outputRate = output;
        events.ready();
        events.response(true); // The agent sends the first message automatically.
        return;
      }
      case 'user_transcript': {
        const transcript = ev.user_transcription_event;
        if (!transcript?.user_transcript || transcript.user_transcript === NOTE_CUE) return;
        events.response(true);
        events.speech(false);
        events.caption(`user-${transcript.event_id ?? ++captionCount}`, 'user', transcript.user_transcript, true, 'set');
        return;
      }
      case 'agent_response': {
        const response = ev.agent_response_event;
        if (!response?.agent_response) return;
        events.response(true);
        events.speech(false);
        lastAgentCaption = `assistant-${response.response_id ?? response.event_id ?? ++captionCount}`;
        events.caption(lastAgentCaption, 'assistant', response.agent_response, true, 'set');
        return;
      }
      case 'agent_response_correction': {
        const correction = ev.agent_response_correction_event;
        if (correction?.corrected_agent_response) {
          events.caption(lastAgentCaption, 'assistant', correction.corrected_agent_response, true, 'set');
        }
        return;
      }
      case 'audio': {
        const audio = ev.audio_event;
        if (audio?.audio_base_64 && (audio.event_id ?? Infinity) >= interruptionId) {
          events.audio(base64ToPcm(audio.audio_base_64), outputRate);
        }
        return;
      }
      case 'interruption':
        interruptionId = ev.interruption_event?.event_id ?? interruptionId;
        events.speech(true);
        events.interrupted();
        return;
      case 'agent_response_complete':
        events.response(false);
        events.settled();
        return;
      case 'client_tool_call': {
        const tool = ev.client_tool_call;
        if (tool) events.tool(tool.tool_call_id, tool.tool_name, tool.parameters ?? {}, tool.expects_response === false ? 'no-reply' : 'reply');
        return;
      }
      case 'ping':
        if (ev.ping_event) send({ type: 'pong', event_id: ev.ping_event.event_id });
        return;
      case 'client_error':
      case 'error':
        events.error(ev.client_error_event?.message ?? ev.error?.message ?? ev.message ?? 'Voice service error');
        return;
    }
  }, events.closed);
  return {
    sendAudio: (pcm) => send({ user_audio_chunk: pcmToBase64(resamplePcm(pcm, inputRate)) }),
    sendToolResult: (id, output, isError) => send({ type: 'client_tool_result', tool_call_id: id, result: output, is_error: isError }),
    sendNote(text) {
      send({ type: 'contextual_update', text });
      // Context is passive. A separate cue starts a turn so the caller hears the outcome now.
      send({ type: 'user_message', text: NOTE_CUE });
      events.response(true);
    },
    close,
  };
}

export function connectVoice(session: VoiceSession, events: CallEvents): VoiceTransport {
  return session.provider === 'elevenlabs' ? connectElevenLabs(session, events) : connectXai(session, events);
}

function connectXai(session: Extract<VoiceSession, { provider: 'xai' }>, events: CallEvents): VoiceTransport {
  let ready = false;
  let responseActive = false;
  let responseSpoke = false;
  let responseId: string | null = null;
  let interruptedId: string | null = null;
  const requestResponse = () => send({ type: 'response.create' });
  const { send, close } = socket(session.websocketUrl, { type: 'session.update', session: session.session }, (ev) => {
    switch (ev.type) {
      case 'session.updated':
        if (!ready) {
          ready = true;
          events.ready();
          requestResponse(); // the bot greets first
        }
        return;

      case 'input_audio_buffer.speech_started':
        events.speech(true);
        // Barge-in: stop talking and listen.
        events.interrupted();
        if (responseActive) {
          interruptedId = responseId;
          send({ type: 'response.cancel' });
        }
        return;
      case 'input_audio_buffer.speech_stopped':
      case 'input_audio_buffer.committed':
        events.speech(false);
        return;

      case 'conversation.item.added':
      case 'conversation.item.created': {
        const item = ev.item ?? {};
        if (item.role === 'user' && Array.isArray(item.content) && item.content.some((c: Json) => c?.type === 'input_audio')) {
          const t = item.content.find((c: Json) => c?.transcript)?.transcript;
          events.caption(item.id, 'user', t ?? '', !!t, 'set');
        }
        return;
      }
      // xAI sends the cumulative transcript in `.updated`; OpenAI sends `.delta` increments.
      case 'conversation.item.input_audio_transcription.updated':
        events.caption(ev.item_id, 'user', ev.transcript ?? '', false, 'set');
        return;
      case 'conversation.item.input_audio_transcription.delta':
        events.caption(ev.item_id, 'user', ev.delta ?? '', false, 'append');
        return;
      case 'conversation.item.input_audio_transcription.completed':
        events.caption(ev.item_id, 'user', ev.transcript ?? '', true, 'set');
        return;

      case 'response.created':
        responseActive = true;
        responseSpoke = false;
        responseId = ev.response?.id ?? null;
        events.response(true);
        return;
      case 'response.output_item.added':
        if (ev.item?.type === 'message') events.caption(ev.item.id, 'assistant', '', false, 'set');
        return;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
      case 'response.output_text.delta':
      case 'response.text.delta':
        responseSpoke = true;
        events.caption(ev.item_id, 'assistant', ev.delta ?? '', false, 'append');
        return;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (ev.transcript) events.caption(ev.item_id, 'assistant', ev.transcript, true, 'set');
        return;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (ev.delta && !(interruptedId && ev.response_id === interruptedId)) {
          responseSpoke = true;
          events.audio(base64ToPcm(ev.delta), session.sampleRate);
        }
        return;

      case 'response.function_call_arguments.done':
        events.tool(ev.call_id, ev.name, decodeArgs(ev.arguments), 'batch');
        return;
      case 'response.done': {
        responseActive = false;
        events.response(false);
        for (const o of (ev.response?.output ?? []) as Json[]) if (o?.type === 'function_call') events.tool(o.call_id, o.name, decodeArgs(o.arguments), 'batch');
        events.finishTools(responseSpoke);
        return;
      }

      case 'error': {
        const code = ev.error?.code ?? ev.code ?? '';
        if (/cancel/i.test(String(code)) || /no active response/i.test(String(ev.error?.message ?? ''))) return;
        console.warn('[voice] realtime error', ev.error ?? ev);
        if (!ready) events.error(ev.error?.message ?? 'Voice service error');
        return;
      }
    }
  }, events.closed, `xai-client-secret.${session.clientSecret}`);
  return {
    sendAudio: (pcm) => send({ type: 'input_audio_buffer.append', audio: pcmToBase64(pcm) }),
    clearInput: () => send({ type: 'input_audio_buffer.clear' }),
    sendToolResult: (id, output) => send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: id, output } }),
    requestResponse,
    sendNote(text) {
      // A user-role item: the model ignores system-role items mid-call.
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
      requestResponse();
    },
    close,
  };
}
