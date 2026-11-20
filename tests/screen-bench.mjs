import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/screen-bench.mjs', import.meta.url));
const version = Buffer.from('RFB 003.008\n');
const password = 'fixtures';
const cookie = 'session=fixture-owner; other=value';
const agentPath = '/websockify?token=fixture-token';
const challenge = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
// Known DES response for the challenge and the bit-reversed password bytes.
const authResponse = Buffer.from('2df6109c71d09221f0039f11c87d217e', 'hex');
const width = 4;
const height = 1;
const sampleSeconds = 0.75;
const rectangleCounts = [1, 2, 4, 3];

function serverInit() {
  const name = Buffer.from('Fake desktop');
  const header = Buffer.alloc(24);
  header.writeUInt16BE(width, 0);
  header.writeUInt16BE(height, 2);
  // 32 bpp, depth 24, little-endian true color, RGB shifts 16/8/0.
  Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0]).copy(header, 4);
  header.writeUInt32BE(name.length, 20);
  return Buffer.concat([header, name]);
}

function framebufferUpdate(rectCount, full, startX = 0) {
  const rectangleWidth = full ? width / rectCount : 1;
  const header = Buffer.alloc(4);
  header.writeUInt16BE(rectCount, 2);
  const encodings = full ? [0, 0] : [7, 1, 0, 0].slice(0, rectCount);
  const rectangles = encodings.map((encoding, x) => {
    const payloadBytes = encoding === 0 ? rectangleWidth * height * 4 : 4;
    const rectangle = Buffer.alloc(12 + payloadBytes);
    rectangle.writeUInt16BE(startX + x * rectangleWidth, 0);
    rectangle.writeUInt16BE(rectangleWidth, 4);
    rectangle.writeUInt16BE(height, 6);
    rectangle.writeInt32BE(encoding, 8);
    if (encoding === 0) rectangle.fill(0xab, 12);
    // Tight Fill with a three-byte RGB pixel. CopyRect's source stays at (0, 0).
    if (encoding === 7) Buffer.from([0x80, 0xab, 0xcd, 0xef]).copy(rectangle, 12);
    return rectangle;
  });
  return Buffer.concat([header, ...rectangles]);
}

async function fakeScreen(t, direct, { control = false, stallControl = false } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const requests = [];
  const pointerEvents = [];
  let failure;
  let sampleBytes = 0;
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  server.on('connection', (socket, request) => {
    const send = (message, split) => {
      socket.send(message.subarray(0, split));
      socket.send(message.subarray(split));
    };

    let pending = Buffer.alloc(0);
    let step = 'version';
    let fullFrameTimer;
    let controlFrameTimer;
    let fullFrameSent = false;
    let pointerX;
    let sentUnrelatedUpdate;
    socket.once('close', () => {
      clearTimeout(fullFrameTimer);
      clearTimeout(controlFrameTimer);
    });
    try {
      assert.equal(request.url, direct ? agentPath : `/api/bots/fixture-bot/screen?mode=${control ? 'control' : 'watch'}`);
      assert.equal(request.headers.cookie, direct ? undefined : cookie);
      send(version, 5);
    } catch (error) {
      failure = error;
      socket.close();
      return;
    }

    const read = (length) => {
      if (pending.length < length) return null;
      const message = pending.subarray(0, length);
      pending = pending.subarray(length);
      return message;
    };

    function accept() {
      switch (step) {
        case 'version': {
          const message = read(version.length);
          if (!message) return false;
          assert.deepEqual(message, version);
          send(Buffer.from([1, direct ? 2 : 1]), 1);
          step = 'security';
          return true;
        }
        case 'security': {
          const message = read(1);
          if (!message) return false;
          assert.equal(message[0], direct ? 2 : 1);
          if (direct) send(challenge, 7);
          else send(Buffer.alloc(4), 2);
          step = direct ? 'challenge' : 'init';
          return true;
        }
        case 'challenge': {
          const message = read(authResponse.length);
          if (!message) return false;
          assert.deepEqual(message, authResponse);
          send(Buffer.alloc(4), 2);
          step = 'init';
          return true;
        }
        case 'init': {
          const message = read(1);
          if (!message) return false;
          assert.equal(message[0], 1);
          send(serverInit(), 26);
          step = 'updates';
          return true;
        }
        case 'updates':
          return acceptClientMessage();
      }
    }

    function acceptClientMessage() {
      if (!pending.length) return false;
      switch (pending[0]) {
        case 0: {
          const message = read(20);
          if (!message) return false;
          assert.equal(message[4], 32);
          assert.equal(message[5], 24);
          return true;
        }
        case 2: {
          if (pending.length < 4) return false;
          const count = pending.readUInt16BE(2);
          const message = read(4 + count * 4);
          if (!message) return false;
          const encodings = Array.from({ length: count }, (_, i) => message.readInt32BE(4 + i * 4));
          assert.ok(encodings.includes(0), 'client advertises Raw');
          assert.ok(encodings.includes(1), 'client advertises CopyRect');
          assert.ok(encodings.includes(7), 'client advertises Tight');
          assert.ok(encodings.includes(-26), 'client advertises Tight quality level 6');
          assert.ok(encodings.includes(control ? -255 : -254), 'client advertises Tight compression level');
          return true;
        }
        case 3: {
          const message = read(10);
          if (!message) return false;
          const full = requests.length === 0;
          assert.equal(message[1], full ? 0 : 1);
          assert.deepEqual([...message.subarray(2)], [0, 0, 0, 0, 0, width, 0, height]);
          const count = full ? 2 : rectangleCounts[requests.length - 1];
          requests.push(message[1]);
          if (full) {
            const update = framebufferUpdate(count, true);
            socket.send(update.subarray(0, update.length - 1));
            fullFrameTimer = setTimeout(() => {
              fullFrameSent = true;
              socket.send(update.subarray(update.length - 1));
            }, 40);
          } else {
            assert.equal(fullFrameSent, true, 'client waits for the full frame');
            if (control) {
              assert.notEqual(pointerX, undefined, 'input precedes the update request');
              if (!sentUnrelatedUpdate) {
                send(framebufferUpdate(1, false, width - 1 - pointerX), 13);
                sentUnrelatedUpdate = true;
              } else if (!stallControl) {
                const update = framebufferUpdate(1, false, pointerX);
                // Delay the last byte so the sample includes receiving the rectangle.
                socket.send(update.subarray(0, update.length - 1));
                controlFrameTimer = setTimeout(() => {
                  pointerX = undefined;
                  socket.send(update.subarray(update.length - 1));
                }, 18);
              }
            } else if (count !== undefined) {
              const update = framebufferUpdate(count, false);
              sampleBytes += update.length;
              send(update, 13);
            }
          }
          return true;
        }
        case 5: {
          const message = read(6);
          if (!message) return false;
          assert.equal(control, true);
          assert.equal(fullFrameSent, true, 'client waits for the full frame before sending input');
          assert.equal(pointerX, undefined, 'client waits for the matching rectangle before sending more input');
          assert.equal(message[1], 0, 'pointer moves without clicking');
          assert.equal(message.readUInt16BE(4), height - 1);
          pointerX = message.readUInt16BE(2);
          assert.equal(pointerX, pointerEvents.length % 2 === 0 ? width - 1 : 0);
          pointerEvents.push(pointerX);
          sentUnrelatedUpdate = false;
          return true;
        }
        default:
          assert.fail(`Unexpected RFB client message type ${pending[0]}`);
      }
    }

    socket.on('message', (data, binary) => {
      try {
        assert.equal(binary, true);
        pending = Buffer.concat([pending, data]);
        while (accept()) {
          // WebSocket message boundaries are independent of RFB message boundaries.
        }
      } catch (error) {
        failure = error;
        socket.close();
      }
    });
  });

  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    pointerEvents,
    get sampleBytes() { return sampleBytes; },
    get failure() { return failure; },
  };
}

for (const direct of [true, false]) {
  test(`screen benchmark measures fragmented RFB over ${direct ? 'direct VNC auth' : 'Owner watch'}`, async (t) => {
    const fixture = await fakeScreen(t, direct);
    const args = direct ? [] : ['--hq-url', fixture.origin, '--bot-id', 'fixture-bot'];
    const env = direct
      ? { AGENT_WEBSOCKIFY_URL: `${fixture.origin.replace('http:', 'ws:')}${agentPath}`, VNC_PASSWORD: password }
      : { OWNER_SESSION_COOKIE: cookie };
    const { stdout } = await execFileAsync(
      process.execPath,
      [script, ...args, '--seconds', String(sampleSeconds)],
      { env, timeout: 5000 },
    ).catch((error) => { throw fixture.failure ?? error; });

    assert.ifError(fixture.failure);
    assert.deepEqual(fixture.requests, [0, 1, 1, 1, 1, 1]);
    const metrics = JSON.parse(stdout);
    assert.ok(Number.isFinite(metrics.firstFrameMs) && metrics.firstFrameMs >= 30);
    assert.equal(metrics.medianRects, 2.5);
    assert.equal(metrics.updatesPerSecond, rectangleCounts.length / sampleSeconds);
    assert.equal(metrics.bytesPerSecond, fixture.sampleBytes / sampleSeconds);
    assert.equal('inputLatencyMs' in metrics, false);
  });

  test(`screen benchmark measures input latency over ${direct ? 'direct VNC auth' : 'Owner control'}`, async (t) => {
    const fixture = await fakeScreen(t, direct, { control: true });
    const args = direct ? [] : ['--hq-url', fixture.origin, '--bot-id', 'fixture-bot'];
    const env = direct
      ? { AGENT_WEBSOCKIFY_URL: `${fixture.origin.replace('http:', 'ws:')}${agentPath}`, VNC_PASSWORD: password }
      : { OWNER_SESSION_COOKIE: cookie };
    const { stdout } = await execFileAsync(
      process.execPath,
      [script, ...args, '--control', '--seconds', '3'],
      { env, timeout: 5000 },
    ).catch((error) => { throw fixture.failure ?? error; });

    assert.ifError(fixture.failure);
    assert.equal(fixture.pointerEvents.length, 20);
    assert.deepEqual(fixture.requests, [0, ...Array(40).fill(1)]);
    const metrics = JSON.parse(stdout);
    assert.ok(Number.isFinite(metrics.inputLatencyMs) && metrics.inputLatencyMs >= 15);
  });
}

test('screen benchmark reports no input latency if the matching rectangle never arrives', async (t) => {
  const fixture = await fakeScreen(t, false, { control: true, stallControl: true });
  const { stdout } = await execFileAsync(
    process.execPath,
    [script, '--hq-url', fixture.origin, '--bot-id', 'fixture-bot', '--control', '--seconds', '0.25'],
    { env: { OWNER_SESSION_COOKIE: cookie }, timeout: 5000 },
  ).catch((error) => { throw fixture.failure ?? error; });

  assert.ifError(fixture.failure);
  assert.deepEqual(fixture.pointerEvents, [width - 1]);
  assert.equal(JSON.parse(stdout).inputLatencyMs, null);
});
