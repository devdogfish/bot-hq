import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

// The transcript's browser-only layout effects do not run during static rendering.
process.env.NODE_ENV = 'production';
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { Transcript } = await tsImport('../web/src/components/Transcript.tsx', {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL('../web/tsconfig.json', import.meta.url)),
});

const timeout = 'operation was aborted due to timeout';
const start = (ref = 'monitor') => ({ type: 'event', event: 'routine-run', text: 'Running routine: Monitor', ref });
const failure = (error = timeout, routineId) => ({
  type: 'notice', tone: 'error', text: `Something went wrong: ${error}`, routineId,
});
const pause = { type: 'notice', tone: 'warn', text: `Paused Monitor after 3 failed runs: ${timeout}. Turn it back on in Manage.` };

function render(bodies) {
  const rows = bodies.map((body, i) => ({
    botId: 'sam', generation: 0, seq: i + 1, updatedSeq: i + 1,
    kind: body.type, body, createdAt: 1_700_000_000_000 + i * 1000,
  }));
  return renderToStaticMarkup(createElement(Transcript, { bot: { id: 'sam' }, rows, loaded: true }));
}

test('the transcript renders twelve repeated failure pairs as one row', () => {
  const repeated = Array.from({ length: 12 }, (_, i) => [start(), failure(timeout, i < 6 ? undefined : 'monitor')]).flat();
  const html = render([...repeated, pause]);
  assert.equal((html.match(/class="notice is-error"/g) ?? []).length, 1);
  assert.ok(html.includes(`Monitor failed ×12 · ${timeout}</div>`));
  assert.ok(html.includes(pause.text));
  assert.ok(!html.includes(start().text));
});

test('the transcript preserves individual runs across errors, routine IDs, and other rows', () => {
  const html = render([
    start(), failure('connection refused'),
    start(), failure(),
    start('other'), failure(),
    start(), failure(),
    pause,
    start(), failure(),
    start(), failure(timeout, 'other'),
    start(),
  ]);
  assert.ok(!html.includes('failed ×'));
  assert.equal((html.match(/class="notice is-error"/g) ?? []).length, 6);
  assert.equal((html.match(/Running routine: Monitor/g) ?? []).length, 7);
  assert.ok(html.includes('connection refused'));
});
