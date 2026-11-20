#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';

const FIRST_FRAME_TIMEOUT_MS = 15_000;
const HELP = `Usage:
  OWNER_SESSION_COOKIE=… node scripts/screen-bench.mjs --hq-url <base URL> --bot-id <id> [--seconds <N>]
  VNC_PASSWORD=… node scripts/screen-bench.mjs --agent-url <websockify URL> [--seconds <N>]

Duration defaults to 10 seconds. Credentials are read from the environment.`;

function argumentsForBench() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        'hq-url': { type: 'string' },
        'bot-id': { type: 'string' },
        'agent-url': { type: 'string' },
        seconds: { type: 'string', default: '10' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch {
    throw new Error('Invalid arguments. Use --help for usage.');
  }
  if (values.help) return null;

  const hqUrl = values['hq-url'];
  const agentUrl = values['agent-url'];
  const botId = values['bot-id'];
  if (!(hqUrl && botId && agentUrl === undefined) && !(agentUrl && hqUrl === undefined && botId === undefined)) {
    throw new Error('Supply either --hq-url with --bot-id or --agent-url.');
  }
  const seconds = Number(values.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2_147_483_647) {
    throw new Error('--seconds must be positive and within the Node timer range.');
  }

  let url;
  try {
    url = new URL(hqUrl ?? agentUrl);
  } catch {
    throw new Error('Invalid endpoint URL.');
  }
  if (hqUrl && url.protocol === 'http:') url.protocol = 'ws:';
  if (hqUrl && url.protocol === 'https:') url.protocol = 'wss:';
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Invalid WebSocket endpoint. Use a URL with no user info or fragment.');
  }
  if (hqUrl) {
    // Avoid URL path normalization for the special dot segments.
    if (botId === '.' || botId === '..') throw new Error('Invalid bot ID.');
    const cookie = process.env.OWNER_SESSION_COOKIE;
    if (!cookie || /[\r\n]/.test(cookie)) throw new Error('Set OWNER_SESSION_COOKIE to the Owner Cookie header.');
    url.pathname = `/api/bots/${encodeURIComponent(botId)}/screen`;
    url.search = '?mode=watch';
    return { url, seconds, headers: { Cookie: cookie } };
  }
  const password = process.env.VNC_PASSWORD;
  if (!password) throw new Error('Set VNC_PASSWORD for direct Agent mode.');
  return { url, seconds, password };
}

// RFB is a stream. A WebSocket message may contain any portion of it.
class RfbReader {
  #chunks = [];
  #offset = 0;
  #wake;
  #failure;

  push(chunk) {
    if (chunk.length === 0 || this.#failure) return;
    this.#chunks.push(chunk);
    this.#wake?.();
  }

  stop(error) {
    this.#failure ??= error;
    this.#wake?.();
  }

  async #consume(length, output) {
    let written = 0;
    while (written < length) {
      if (this.#failure) throw this.#failure;
      if (this.#chunks.length === 0) {
        await new Promise((resolve) => { this.#wake = resolve; });
        this.#wake = undefined;
        continue;
      }
      const chunk = this.#chunks[0];
      const count = Math.min(length - written, chunk.length - this.#offset);
      output?.set(chunk.subarray(this.#offset, this.#offset + count), written);
      written += count;
      this.#offset += count;
      if (this.#offset === chunk.length) {
        this.#chunks.shift();
        this.#offset = 0;
      }
    }
    return output;
  }

  read(length) {
    return this.#consume(length, Buffer.allocUnsafe(length));
  }

  skip(length) {
    return this.#consume(length);
  }
}

async function handshake(reader, send, password, vncAuthResponse) {
  const banner = (await reader.read(12)).toString('ascii');
  const minorVersion = Number(/^RFB 003\.(\d{3})\n$/.exec(banner)?.[1]);
  if (!(minorVersion >= 3)) throw new Error('Unsupported RFB protocol version.');
  const version = minorVersion >= 8 ? 8 : minorVersion >= 7 ? 7 : 3;
  send(Buffer.from(`RFB 003.00${version}\n`));

  const security = password === undefined ? 1 : 2;
  if (version === 3) {
    const offered = (await reader.read(4)).readUInt32BE();
    if (offered === 0) throw new Error('RFB server refused the connection.');
    if (offered !== security) throw new Error('RFB server does not support the required security type.');
  } else {
    const [count] = await reader.read(1);
    if (count === 0) throw new Error('RFB server refused the connection.');
    if (!(await reader.read(count)).includes(security)) {
      throw new Error('RFB server does not support the required security type.');
    }
    send(Buffer.from([security]));
  }

  if (security === 2) send(vncAuthResponse(password, await reader.read(16)));
  if (security === 2 || version === 8) {
    const result = (await reader.read(4)).readUInt32BE();
    if (result !== 0) throw new Error('RFB authentication failed.');
  }
  send(Buffer.from([1])); // ClientInit: shared session

  const init = await reader.read(24);
  const width = init.readUInt16BE(0);
  const height = init.readUInt16BE(2);
  if (width === 0 || height === 0) throw new Error('RFB server returned an empty framebuffer.');
  await reader.skip(init.readUInt32BE(20)); // desktop name
  return { width, height };
}

const RAW = 0;
const COPY_RECT = 1;
const TIGHT = 7;
const LAST_RECT = -224;
const TIGHT_QUALITY_LEVEL_6 = -26;
const TIGHT_COMPRESSION_LEVEL_2 = -254;

function setEncodings(send) {
  // 32bpp, 24-bit true color, little endian, 8 bits per channel, RGB shifts 0/8/16.
  send(Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]));
  const encodings = [COPY_RECT, TIGHT, RAW, TIGHT_QUALITY_LEVEL_6, TIGHT_COMPRESSION_LEVEL_2, LAST_RECT];
  const message = Buffer.alloc(4 + encodings.length * 4);
  message[0] = 2;
  message.writeUInt16BE(encodings.length, 2);
  encodings.forEach((encoding, index) => message.writeInt32BE(encoding, 4 + index * 4));
  send(message);
}

function requestFramebuffer(send, { width, height }, incremental) {
  const request = Buffer.alloc(10);
  request[0] = 3;
  request[1] = Number(incremental);
  request.writeUInt16BE(width, 6);
  request.writeUInt16BE(height, 8);
  send(request);
}

// Tight uses one to three bytes for a packed payload length.
async function tightLength(reader) {
  const [first] = await reader.read(1);
  if (first < 128) return first;
  const [second] = await reader.read(1);
  const length = (first & 127) | ((second & 127) << 7);
  if (second < 128) return length;
  const [third] = await reader.read(1);
  return length | (third << 14);
}

async function skipTight(reader, width, height) {
  const [control] = await reader.read(1);
  const mode = control >> 4;
  if (mode === 8) return reader.skip(3); // Fill
  if (mode === 9) return reader.skip(await tightLength(reader)); // JPEG
  if (mode > 7) throw new Error('Unsupported Tight compression mode.');

  let length = width * height * 3;
  if (mode & 4) {
    const [filter] = await reader.read(1);
    if (filter === 1) {
      const [paletteSizeMinusOne] = await reader.read(1);
      const paletteSize = paletteSizeMinusOne + 1;
      await reader.skip(paletteSize * 3);
      length = (paletteSize <= 2 ? Math.ceil(width / 8) : width) * height;
    } else if (filter !== 0 && filter !== 2) {
      throw new Error('Unsupported Tight filter.');
    }
  }
  return reader.skip(length < 12 ? length : await tightLength(reader));
}

async function readRectangles(reader, count) {
  for (let index = 0; index < count; index++) {
    const rectangle = await reader.read(12);
    const width = rectangle.readUInt16BE(4);
    const height = rectangle.readUInt16BE(6);
    const encoding = rectangle.readInt32BE(8);
    switch (encoding) {
      case RAW: await reader.skip(width * height * 4); break;
      case COPY_RECT: await reader.skip(4); break;
      case TIGHT: await skipTight(reader, width, height); break;
      case LAST_RECT: return index;
      default: throw new Error(`Unsupported RFB rectangle encoding ${encoding}.`);
    }
  }
  return count;
}

async function readUpdate(reader) {
  for (;;) {
    const [type] = await reader.read(1);
    switch (type) {
      case 0: { // FramebufferUpdate
        const header = await reader.read(3);
        return readRectangles(reader, header.readUInt16BE(1));
      }
      case 1: { // SetColorMapEntries
        const header = await reader.read(5);
        await reader.skip(header.readUInt16BE(3) * 6);
        break;
      }
      case 2: break; // Bell
      case 3: { // ServerCutText
        const header = await reader.read(7);
        await reader.skip(Math.abs(header.readInt32BE(3)));
        break;
      }
      default: throw new Error(`Unsupported RFB server message ${type}.`);
    }
  }
}

function median(numbers) {
  if (!numbers.length) return null;
  numbers.sort((a, b) => a - b);
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

async function benchmark({ url, headers, password, seconds }) {
  let vncAuthResponse;
  if (password !== undefined) {
    const { tsImport } = await import('tsx/esm/api');
    ({ vncAuthResponse } = await tsImport('../server/src/lib/des.ts', import.meta.url));
  }

  const reader = new RfbReader();
  const done = new Error('Measurement window ended.');
  const started = performance.now();
  const socket = new WebSocket(url, ['binary'], { headers, perMessageDeflate: false });
  let deadline = 0;
  let measuredBytes = 0;
  socket.on('message', (chunk, isBinary) => {
    if (!isBinary) {
      reader.stop(new Error('Expected binary WebSocket messages.'));
      return;
    }
    if (performance.now() < deadline) measuredBytes += chunk.length;
    reader.push(chunk);
  });
  // WebSocket errors and server-provided strings may include credentials.
  socket.on('error', () => reader.stop(new Error('WebSocket connection failed.')));
  socket.on('unexpected-response', (_request, response) => {
    reader.stop(new Error(`WebSocket upgrade failed with HTTP ${response.statusCode}.`));
  });
  socket.on('close', (code) => reader.stop(new Error(`WebSocket closed early (code ${code}).`)));
  const send = (data) => {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket closed early.');
    socket.send(data);
  };

  let timer = setTimeout(() => reader.stop(new Error('Timed out waiting for the first framebuffer.')), FIRST_FRAME_TIMEOUT_MS);
  try {
    const size = await handshake(reader, send, password, vncAuthResponse);
    setEncodings(send);
    do {
      requestFramebuffer(send, size, false);
    } while (await readUpdate(reader) === 0);
    const firstFrameTime = performance.now();
    const firstFrameMs = firstFrameTime - started;

    clearTimeout(timer);
    deadline = firstFrameTime + seconds * 1000;
    timer = setTimeout(() => reader.stop(done), seconds * 1000);
    const counts = [];
    try {
      while (performance.now() < deadline) {
        requestFramebuffer(send, size, true);
        const rectangles = await readUpdate(reader);
        if (performance.now() < deadline) counts.push(rectangles);
      }
    } catch (error) {
      if (error !== done) throw error;
    }
    return {
      firstFrameMs,
      updatesPerSecond: counts.length / seconds,
      bytesPerSecond: measuredBytes / seconds,
      medianRects: median(counts),
    };
  } finally {
    clearTimeout(timer);
    socket.terminate();
  }
}

try {
  const options = argumentsForBench();
  if (options) console.log(JSON.stringify(await benchmark(options)));
  else console.log(HELP);
} catch (error) {
  console.error(`screen-bench: ${error.message}`);
  process.exitCode = 1;
}
