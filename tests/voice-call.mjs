// Offline: node --import tsx --test tests/voice-call.mjs
// Live xAI smoke: node tests/voice-call.mjs <outDir> <throwawayBotId>
if (process.argv[3]) await import('./voice-call-live.mjs');
else {
  const { default: assert } = await import('node:assert/strict');
  const { after, test } = await import('node:test');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { Hono } = await import('hono');

  const realFetch = globalThis.fetch;
  const http = { fetch: (input) => assert.fail(`Unhandled test fetch: ${input}`) };
  // Install before import so the summary SDK also captures the fake fetch.
  globalThis.fetch = (...args) => http.fetch(...args);
  after(() => { globalThis.fetch = realFetch; });

  Object.assign(process.env, {
    DB_PATH: ':memory:', SESSION_SECRET: 'voice-test', XAI_API_KEY: 'test-xai-key',
    ELEVENLABS_API_KEY: 'test-elevenlabs-key', ELEVENLABS_AGENT_ID: 'test-agent',
    HQ_LOCAL_ENGINES: '1', HERMES_HOME_PRIMARY: '/nonexistent/voice-test-home',
    HERMES_URL: 'https://hermes.voice.test', HERMES_KEY: 'test-hermes-key',
  });
  const { env } = await import('../server/src/env.ts');
  const { db } = await import('../server/src/db.ts');
  const { api } = await import('../server/src/routes.ts');
  const { initRooms } = await import('../server/src/agent/rooms.ts');
  const { initSubagents } = await import('../server/src/agent/subagents.ts');
  const { listRows } = await import('../server/src/store.ts');
  const { hub } = await import('../server/src/lib/hub.ts');
  const { VOICE_TOOLS } = await import('../server/src/voice/tools.ts');
  const { syncElevenLabsAgent } = await import('../server/scripts/elevenlabs-sync-agent.ts');
  const { useStore } = await import('../web/src/store.ts');
  const { startCall, endCall, useVoice, toggleMute } = await import('../web/src/voice/call.ts');
  const { voiceApi } = await import('../web/src/voice/api.ts');

  initSubagents();
  initRooms();
  const app = new Hono().route('/api', api);
  db.exec(`
    INSERT INTO users (id, email, name, created_at)
      VALUES ('owner', 'owner@example.test', 'Jo Tester', 0), ('other', 'other@example.test', 'Other User', 0);
    INSERT INTO auth_sessions (token, user_id, created_at, expires_at)
      VALUES ('voice-test', 'owner', 0, 9999999999999), ('other-session', 'other', 0, 9999999999999);
    INSERT INTO bots (id, user_id, name, instructions, created_at, updated_at, engine)
      VALUES ('xai-bot', 'owner', 'Default', 'Default-only prompt', 0, 0, 'primary'),
        ('eleven-bot', 'owner', 'Relay', 'Relay-only prompt', 0, 0, 'primary'),
        ('other-bot', 'other', 'Other bot', 'Other-owner prompt', 0, 0, 'primary');
  `);
  const cookie = 'grokbot_session=voice-test';
  const signedUrl = 'wss://api.elevenlabs.io/v1/convai/conversation?token=test-signed-token';
  const voiceId = 'fake-elevenlabs-voice';
  const pcm = Buffer.alloc(24).toString('base64');

  function request(path, method = 'GET', data, sessionCookie = cookie) {
    return app.request(path, {
      method, headers: { cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  }

  async function configureElevenBot() {
    const response = await request('/api/bots/eleven-bot', 'PATCH', {
      voice_provider: 'elevenlabs', voice: voiceId, voiceSpeed: 1.5, voiceLanguage: 'pt-BR',
    });
    assert.equal(response.status, 200);
    return (await response.json()).bot;
  }

  function fakeHttp(t) {
    const calls = [];
    t.mock.method(http, 'fetch', async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input, 'https://app.voice.test');
      if (url.host === 'app.voice.test') {
        calls.push({ url, method: init?.method, body: init?.body });
        const headers = new Headers(init?.headers);
        headers.set('cookie', cookie);
        return app.request(url, { ...init, headers });
      }
      const req = new Request(input, init);
      calls.push({ url, method: req.method, body: await req.clone().text() });
      switch (url.host) {
        case 'api.elevenlabs.io':
          assert.equal(req.headers.get('xi-api-key'), 'test-elevenlabs-key');
          assert.equal(req.redirect, 'error');
          switch (url.pathname) {
            case '/v1/convai/conversation/get-signed-url':
              assert.equal(req.method, 'GET');
              assert.equal(url.searchParams.get('agent_id'), 'test-agent');
              assert.equal(url.searchParams.get('include_conversation_id'), 'true');
              return Response.json({ signed_url: signedUrl });
            case '/v2/voices':
              return url.searchParams.has('next_page_token')
                ? Response.json({ voices: [{ voice_id: 'next-id', name: 'Other' }] })
                : Response.json({ voices: [{ voice_id: voiceId, name: 'Sample', labels: { gender: 'female' } }], has_more: true, next_page_token: 'next' });
            case `/v1/text-to-speech/${voiceId}`:
              assert.equal(url.searchParams.get('output_format'), 'pcm_24000');
              assert.deepEqual(await req.json(), { text: "Hi, I'm Relay. This is how I'll sound when we talk.", model_id: 'eleven_flash_v2_5', language_code: 'pt', voice_settings: { speed: 1.2 } });
              return new Response(Buffer.alloc(24));
            case '/v1/speech-to-text': {
              const form = await req.formData();
              assert.equal(form.get('model_id'), 'scribe_v2');
              assert.equal(form.get('language_code'), 'pt');
              assert.equal(form.get('file').size, 400);
              return Response.json({ text: '  hello there  ' });
            }
          }
          break;
        case 'api.x.ai':
          assert.equal(req.headers.get('authorization'), 'Bearer test-xai-key');
          switch (url.pathname) {
            case '/v1/tts/voices':
              return Response.json({ voices: [{ voice_id: 'luna', name: 'Luna' }] });
            case '/v1/realtime/client_secrets':
              assert.deepEqual(await req.json(), { expires_after: { seconds: 300 } });
              return Response.json({ value: 'ephemeral-xai', expires_at: Math.floor(Date.now() / 1000) + 300 });
            case '/v1/tts':
              assert.deepEqual(await req.json(), {
                text: "Hi, I'm Default. This is how I'll sound when we talk.",
                voice_id: 'luna', language: 'auto', speed: 1, output_format: { codec: 'pcm', sample_rate: 24000 },
              });
              return new Response(Buffer.alloc(24));
            case '/v1/stt': {
              const form = await req.formData();
              assert.deepEqual([...form.keys()], ['model', 'language', 'file']);
              assert.equal(form.get('language'), 'fr');
              return Response.json({ text: ' salut ' });
            }
            case '/v1/responses':
              return Response.json({ object: 'response', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Talked on a call.' }] }] });
          }
          break;
        case 'hermes.voice.test': {
          const { input: prompt } = await req.json();
          assert.match(prompt, /\[Voice call: Jo asked/);
          assert.match(prompt, /Can you check the weather\?/);
          return new Response('event: run.completed\ndata: {"output":"It is sunny."}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
      }
      assert.fail(`Unexpected fetch ${req.method} ${url}`);
    });
    return calls;
  }

  function fakeBrowser(t) {
    const socket = [];
    const playback = [];
    const mic = { enabled: true, stop() {} };
    let worklet;
    class FakeSocket {
      static OPEN = 1;
      readyState = 0;
      sent = [];
      constructor(url, protocols) { Object.assign(this, { url, protocols }); socket.push(this); }
      open() { this.readyState = FakeSocket.OPEN; this.onopen(); }
      send(data) { this.sent.push(JSON.parse(data)); }
      receive(event) { this.onmessage({ data: JSON.stringify(event) }); }
      close() { this.readyState = 3; this.onclose({ reason: '' }); }
    }
    class FakeWorklet {
      port = {};
      constructor() { worklet = this; }
      connect(node) { return node; }
      disconnect() {}
    }
    class FakeContext {
      state = 'running';
      currentTime = 0;
      audioWorklet = { addModule: async () => {} };
      resume = async () => {};
      close = async () => {};
      createGain() { return { gain: {}, connect: (node) => node, disconnect() {} }; }
      createAnalyser() { return this.createGain(); }
      createMediaStreamSource() { return this.createGain(); }
      createBuffer(_, length, rate) {
        return { rate, duration: length / rate, getChannelData: () => new Float32Array(length) };
      }
      createBufferSource() {
        return {
          connect() {},
          start() { playback.push(this); },
          stop() { this.stopped = true; },
        };
      }
    }
    const globals = {
      WebSocket: FakeSocket,
      window: Object.assign(new EventTarget(), { AudioContext: FakeContext }),
      AudioWorkletNode: FakeWorklet,
      navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [mic], getAudioTracks: () => [mic] }) } },
    };
    for (const [key, value] of Object.entries(globals)) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, key);
      Object.defineProperty(globalThis, key, { value, configurable: true });
      t.after(() => {
        if (previous) Object.defineProperty(globalThis, key, previous);
        else delete globalThis[key];
      });
    }
    return {
      socket, playback, mic,
      capture: () => worklet.port.onmessage({ data: { pcm: new Int16Array(960).buffer, level: 0.6 } }),
    };
  }

  async function until(predicate, message) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const result = predicate();
      if (result) return result;
      await delay(20);
    }
    assert.fail(message);
  }

  test('voice options, provider setting, and ElevenLabs preview and dictation', async (t) => {
    fakeHttp(t);
    assert.equal((await app.request('/api/voice/options')).status, 401);
    const saved = await (await request('/api/voice/options')).json();
    assert.deepEqual(saved.providers, [{ id: 'xai', name: 'xAI', available: true }, { id: 'elevenlabs', name: 'ElevenLabs', available: true }]);
    assert.deepEqual(saved.voices.xai, [{ id: 'luna', name: 'Luna' }]);
    assert.deepEqual(saved.voices.elevenlabs, [{ id: voiceId, name: 'Sample', gender: 'female' }, { id: 'next-id', name: 'Other' }]);
    assert.equal((await voiceApi.options()).voices[0].id, 'luna');
    assert.equal((await request('/api/bots/eleven-bot', 'PATCH', { voice_provider: 'other' })).status, 400);
    const patched = await configureElevenBot();
    assert.equal(patched.voiceProvider, 'elevenlabs');
    assert.equal(patched.voice, voiceId);
    assert.equal((await voiceApi.preview({ botId: 'eleven-bot' })).length, 12);
    assert.equal(await voiceApi.transcribe(new Blob([Buffer.alloc(400)]), 'pt-BR', 'eleven-bot'), 'hello there');
    assert.equal((await voiceApi.preview({ botId: 'xai-bot' })).length, 12);
    assert.equal(await voiceApi.transcribe(new Blob([Buffer.alloc(400)]), 'fr', 'xai-bot'), 'salut');
    const patch = await (await request('/api/bots/xai-bot', 'PATCH', { voice_provider: 'elevenlabs' })).json();
    assert.ok(patch.bot.voice && patch.bot.voice !== 'luna');
    const reset = await (await request('/api/bots/xai-bot', 'PATCH', { voice_provider: 'xai' })).json();
    assert.equal(reset.bot.voice, 'luna');
    const xaiKey = env.xaiKey;
    const elevenKey = env.elevenlabsKey;
    t.after(() => { env.xaiKey = xaiKey; env.elevenlabsKey = elevenKey; });
    env.xaiKey = '';
    const elevenOnly = await (await request('/api/voice/options')).json();
    assert.deepEqual(elevenOnly.providers.map((p) => p.available), [false, true]);
    env.elevenlabsKey = '';
    const unavailable = await (await request('/api/voice/options')).json();
    assert.deepEqual(unavailable.providers.map((p) => p.available), [false, false]);
    assert.deepEqual(unavailable.voices, { xai: [], elevenlabs: [] });
  });

  test('ElevenLabs sessions and tool calls are scoped to the owner and the active bot', async (t) => {
    const calls = fakeHttp(t);
    const otherCookie = 'grokbot_session=other-session';
    await configureElevenBot();
    assert.equal((await request('/api/voice/session', 'POST', { botId: 'eleven-bot' }, '')).status, 401);
    assert.equal((await request('/api/voice/session', 'POST', { botId: 'eleven-bot' }, otherCookie)).status, 404);
    assert.equal((await request('/api/voice/preview', 'POST', { botId: 'eleven-bot' }, otherCookie)).status, 404);
    assert.equal(calls.length, 0);

    const response = await request('/api/voice/session', 'POST', {
      botId: 'eleven-bot', agentId: 'other-agent', prompt: 'Untrusted override',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.text();
    assert.doesNotMatch(body, /test-elevenlabs-key|Untrusted override|Default-only prompt|Other-owner prompt/);
    const session = JSON.parse(body);
    assert.equal(session.signedUrl, signedUrl);
    assert.match(session.initData.conversation_config_override.agent.prompt.prompt, /Relay-only prompt/);

    const tool = (botId, callId, sessionCookie) =>
      request('/api/voice/tool', 'POST', { botId, callId, name: 'peek_activity' }, sessionCookie);
    assert.equal((await tool('eleven-bot', session.callId, otherCookie)).status, 404);
    assert.equal((await tool('xai-bot', session.callId)).status, 404);
    assert.equal((await tool('eleven-bot')).status, 404);
    assert.equal((await tool('xai-bot')).status, 200);
    assert.equal((await tool('eleven-bot', session.callId)).status, 200);
    assert.equal((await request('/api/voice/end', 'POST', { botId: 'eleven-bot', callId: session.callId })).status, 200);
    assert.equal((await tool('eleven-bot', session.callId)).status, 404);
  });

  test('ElevenLabs reports missing configuration and keeps upstream diagnostics out of logs', async (t) => {
    const key = env.elevenlabsKey;
    const agentId = env.elevenlabsAgentId;
    t.after(() => { env.elevenlabsKey = key; env.elevenlabsAgentId = agentId; });
    const fetch = t.mock.method(http, 'fetch', async () => Response.json({ detail: key }, { status: 401 }));
    const warn = t.mock.method(console, 'warn', () => {});
    await configureElevenBot();
    env.elevenlabsKey = '';
    const start = () => request('/api/voice/session', 'POST', { botId: 'eleven-bot' });
    const missingKey = await start();
    assert.equal(missingKey.status, 503);
    assert.match((await missingKey.json()).error, /ELEVENLABS_API_KEY/);
    assert.equal((await request('/api/voice/preview', 'POST', { botId: 'eleven-bot' })).status, 503);
    const form = new FormData();
    form.append('botId', 'eleven-bot');
    form.append('file', new Blob([Buffer.alloc(400)]), 'call.webm');
    assert.equal((await app.request('/api/voice/stt', { method: 'POST', headers: { cookie }, body: form })).status, 503);
    env.elevenlabsKey = key;
    env.elevenlabsAgentId = '';
    const missingAgent = await start();
    assert.equal(missingAgent.status, 503);
    assert.match((await missingAgent.json()).error, /ELEVENLABS_AGENT_ID/);
    assert.equal(fetch.mock.callCount(), 0);
    env.elevenlabsAgentId = agentId;
    const rejected = await start();
    assert.equal(rejected.status, 502);
    assert.equal((await rejected.text()).includes(key), false);
    assert.equal(warn.mock.callCount(), 1);
    assert.deepEqual(warn.mock.calls[0].arguments, ['[voice] ElevenLabs request failed', 401]);
  });

  test('ElevenLabs mints, relays work, clears interrupted audio, and speaks the landed result', async (t) => {
    const calls = fakeHttp(t);
    const browser = fakeBrowser(t);
    await configureElevenBot();
    const unsub = hub.subscribe('owner', (event) => useStore.getState().handleEvent(event));
    t.after(() => { endCall(); unsub(); });
    startCall('eleven-bot');
    const ws = await until(() => browser.socket[0], 'ElevenLabs socket did not open');
    const callId = useVoice.getState().callId;
    assert.equal(ws.url, signedUrl);
    assert.equal(ws.protocols, undefined);
    ws.open();
    const init = ws.sent[0];
    assert.equal(init.type, 'conversation_initiation_client_data');
    const { agent, tts } = init.conversation_config_override;
    assert.match(agent.prompt.prompt, /You are Relay, on a live voice call with Jo/);
    assert.equal(agent.first_message, 'Olá, Jo!');
    assert.equal(agent.language, 'pt');
    assert.deepEqual(tts, { voice_id: voiceId, speed: 1.2 });
    assert.doesNotMatch(JSON.stringify(ws.sent), /test-elevenlabs-key/);
    ws.receive({
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: { user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_22050' },
    });
    assert.equal(useVoice.getState().status, 'live');
    browser.capture();
    assert.equal(Buffer.from(ws.sent.at(-1).user_audio_chunk, 'base64').length, 1280);
    toggleMute();
    assert.equal(browser.mic.enabled, false);
    const beforeMute = ws.sent.length;
    browser.capture();
    assert.equal(ws.sent.length, beforeMute);
    toggleMute();
    ws.receive({ type: 'ping', ping_event: { event_id: 7, ping_ms: 4 } });
    assert.deepEqual(ws.sent.at(-1), { type: 'pong', event_id: 7 });

    ws.receive({ type: 'audio', audio_event: { event_id: 1, audio_base_64: pcm } });
    assert.equal(browser.playback[0].buffer.rate, 22050);
    ws.receive({ type: 'interruption', interruption_event: { event_id: 2 } });
    assert.equal(browser.playback[0].stopped, true);
    assert.equal(useVoice.getState().speaking, false);
    ws.receive({ type: 'audio', audio_event: { event_id: 1, audio_base_64: pcm } });
    assert.equal(browser.playback.length, 1);

    const text = 'Can you check the weather?';
    ws.receive({ type: 'user_transcript', user_transcription_event: { event_id: 3, user_transcript: text } });
    ws.receive({ type: 'agent_response', agent_response_event: { event_id: 4, agent_response: 'I’ll check.' } });
    const tool = { type: 'client_tool_call', client_tool_call: { tool_call_id: 'work', tool_name: 'send_task', parameters: { request: text }, expects_response: true } };
    ws.receive(tool);
    ws.receive(tool);
    const result = await until(() => ws.sent.find((ev) => ev.type === 'client_tool_result'), 'Missing ElevenLabs tool result');
    assert.equal(result.tool_call_id, 'work');
    assert.equal(result.is_error, false);
    assert.match(result.result, /Handed off/);
    const relays = calls.filter((c) => c.url.pathname === '/api/voice/tool');
    assert.equal(relays.length, 1);
    assert.deepEqual(JSON.parse(relays[0].body), {
      botId: 'eleven-bot', callId, name: 'send_task', args: { request: text },
    });
    ws.receive({ type: 'agent_response_complete', agent_response_complete_event: { event_id: 4 } });
    const note = await until(() => ws.sent.find((ev) => ev.type === 'contextual_update'), 'Missing work_landed note');
    assert.match(note.text, /\[work_landed\][\s\S]*It is sunny/);
    assert.equal(ws.sent.at(-1).type, 'user_message');
    ws.receive({ type: 'user_transcript', user_transcription_event: { event_id: 5, user_transcript: ws.sent.at(-1).text } });
    ws.receive({ type: 'agent_response', agent_response_event: { event_id: 6, agent_response: 'It is sunny.' } });
    ws.receive({ type: 'audio', audio_event: { event_id: 6, audio_base_64: pcm } });
    assert.equal(browser.playback.length, 2);
    browser.playback.at(-1).onended();
    ws.receive({ type: 'agent_response_complete' });
    ws.receive({ type: 'client_tool_call', client_tool_call: { tool_call_id: 'hangup', tool_name: 'end_the_call' } });
    await until(() => ws.sent.find((ev) => ev.tool_call_id === 'hangup'), 'Missing hangup tool result');
    assert.equal(useVoice.getState().status, 'live');
    ws.receive({ type: 'audio', audio_event: { event_id: 7, audio_base_64: pcm } });
    assert.equal(browser.playback.length, 3);
    ws.receive({ type: 'agent_response_complete' });
    assert.equal(useVoice.getState().status, 'live');
    browser.playback.at(-1).onended();
    const ended = await until(() => listRows('eleven-bot').find((row) =>
      row.body.call?.id === callId && row.body.call.phase === 'ended'), 'No call record');
    assert.deepEqual(ended.body.call.transcript, [
      { role: 'user', text }, { role: 'assistant', text: 'I’ll check.' }, { role: 'assistant', text: 'It is sunny.' },
    ]);
    assert.deepEqual(ended.body.call.tasks, [text]);
    await until(() => listRows('eleven-bot').some((row) =>
      row.body.call?.id === callId && row.body.call.summary === 'Talked on a call.'), 'No call summary');
  });

  test('xAI still greets, streams PCM, interrupts and batches tool results', async (t) => {
    const calls = fakeHttp(t);
    const browser = fakeBrowser(t);
    t.after(endCall);
    startCall('xai-bot');
    const ws = await until(() => browser.socket[0], 'xAI socket did not open');
    assert.match(ws.url, /^wss:\/\/api\.x\.ai\/v1\/realtime/);
    assert.deepEqual(ws.protocols, ['xai-client-secret.ephemeral-xai']);
    ws.open();
    assert.equal(ws.sent[0].type, 'session.update');
    assert.equal(ws.sent[0].session.voice, 'luna');
    assert.deepEqual(ws.sent[0].session.tools, VOICE_TOOLS);
    ws.receive({ type: 'session.updated' });
    assert.deepEqual(ws.sent.at(-1), { type: 'response.create' });
    browser.capture();
    assert.equal(ws.sent.at(-1).type, 'input_audio_buffer.append');
    assert.equal(Buffer.from(ws.sent.at(-1).audio, 'base64').length, 1920);
    toggleMute();
    assert.deepEqual(ws.sent.at(-1), { type: 'input_audio_buffer.clear' });
    toggleMute();

    ws.receive({ type: 'response.created', response: { id: 'greeting' } });
    const audio = { type: 'response.output_audio.delta', response_id: 'greeting', delta: pcm };
    ws.receive(audio);
    assert.equal(browser.playback[0].buffer.rate, 24000);
    ws.receive({ type: 'input_audio_buffer.speech_started' });
    assert.deepEqual(ws.sent.at(-1), { type: 'response.cancel' });
    assert.equal(browser.playback[0].stopped, true);
    ws.receive(audio);
    assert.equal(browser.playback.length, 1);
    ws.receive({ type: 'input_audio_buffer.speech_stopped' });

    const tool = { call_id: 'read', name: 'peek_activity', arguments: '{}' };
    ws.receive({ type: 'response.function_call_arguments.done', ...tool });
    ws.receive({ type: 'response.done', response: { output: [
      { type: 'function_call', ...tool },
      { type: 'function_call', call_id: 'recall', name: 'recall_text_messages', arguments: '{}' },
    ] } });
    await until(() => ws.sent.filter((ev) => ev.type === 'response.create').length === 2, 'xAI did not continue after batched tools');
    assert.deepEqual(ws.sent.slice(-3).map((ev) => ev.item?.call_id ?? ev.type), ['read', 'recall', 'response.create']);
    assert.equal(calls.filter((call) => call.url.pathname === '/api/voice/tool').length, 2);
    endCall();
    await until(() => listRows('xai-bot').find((row) => row.body.call?.phase === 'ended'), 'No xAI call record');
  });

  test('agent sync creates and updates client tools and enables session overrides', async (t) => {
    const tools = new Map();
    let agent;
    t.mock.method(http, 'fetch', async (input, init) => {
      const url = new URL(input);
      const method = init.method;
      assert.equal(init.headers['xi-api-key'], 'test-elevenlabs-key');
      assert.equal(init.redirect, 'error');
      if (url.pathname === '/v1/convai/tools' && method === 'GET') {
        assert.equal(url.searchParams.get('used_by_agent_id'), 'synced-agent');
        return Response.json({ tools: [...tools.values()], has_more: false });
      }
      if (method === 'POST' && url.pathname === '/v1/convai/tools' || method === 'PATCH' && url.pathname.startsWith('/v1/convai/tools/')) {
        const id = method === 'POST' ? `tool-${tools.size}` : url.pathname.split('/').at(-1);
        const tool = { id, ...JSON.parse(init.body) };
        tools.set(id, tool);
        return Response.json(tool);
      }
      assert.ok(method === 'POST' && url.pathname === '/v1/convai/agents/create' || method === 'PATCH' && url.pathname === '/v1/convai/agents/synced-agent');
      agent = JSON.parse(init.body);
      return Response.json({ agent_id: 'synced-agent' });
    });
    assert.equal(await syncElevenLabsAgent('test-elevenlabs-key'), 'synced-agent');
    assert.equal(await syncElevenLabsAgent('test-elevenlabs-key', 'synced-agent'), 'synced-agent');
    assert.deepEqual([...tools.values()].map(({ tool_config }) => tool_config), VOICE_TOOLS.map(({ name, description, parameters }) =>
      ({ type: 'client', name, description, parameters, expects_response: true })));
    assert.deepEqual(agent.conversation_config.agent.prompt.tool_ids, [...tools.keys()]);
    assert.equal(agent.conversation_config.tts.model_id, 'eleven_flash_v2_5');
    assert.equal(agent.conversation_config.language_presets.bn.overrides.tts.model_id, 'eleven_v4_turbo');
    assert.ok(agent.conversation_config.conversation.client_events.includes('agent_response_complete'));
    assert.deepEqual(agent.platform_settings, {
      auth: { enable_auth: true },
      overrides: { conversation_config_override: {
        agent: { prompt: { prompt: true }, first_message: true, language: true },
        tts: { voice_id: true, speed: true },
      } },
    });
  });
}
