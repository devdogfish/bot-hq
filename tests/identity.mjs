import assert from 'node:assert/strict';
import { test } from 'node:test';

Object.assign(process.env, {
  DB_PATH: ':memory:',
  SESSION_SECRET: 'identity-test',
  HQ_LOCAL_ENGINES: '0',
  BOTHQ_TEAM_NAME: 'Dawnshift',
  HQ_PERSONAL_BOT_ID: 'james',
});

const { db } = await import('../server/dist/db.js');
const { initSubagents } = await import('../server/dist/agent/subagents.js');
const { initRooms } = await import('../server/dist/agent/rooms.js');
const { instructionsFor } = await import('../server/dist/agent/prompt.js');
const { voiceInstructions } = await import('../server/dist/voice/index.js');
const { identity } = await import('../server/dist/agent/identity.js');
const { getBotRow } = await import('../server/dist/store.js');
initSubagents();
initRooms();

db.exec(`
  INSERT INTO users (id, email, name, created_at) VALUES ('owner', 'owner@example.test', 'Luigi', 0);
  INSERT INTO bots (id, user_id, name, label, description, kind, is_primary, created_at, updated_at) VALUES
    ('trevor', 'owner', 'Trevor', 'Chief of Staff', 'Assigns business requests.', 'agent', 1, 0, 0),
    ('sam', 'owner', 'Sam Lee', 'Sales Development Rep', 'Owns sales and outreach.', 'agent', 0, 1, 1),
    ('stacy', 'owner', 'Stacy Ross', 'Growth and Marketing Generalist', '', 'agent', 0, 2, 2),
    ('old', 'owner', 'Tyler Pilot', '', '', 'agent', 0, 3, 3),
    ('james', 'owner', 'James Diaz', 'Personal Assistant', '', 'agent', 0, 4, 4),
    ('room', 'owner', 'Team room', '', '', 'room', 0, 5, 5);
  UPDATE bots SET archived_at=1 WHERE id='old';
`);

test('text, voice and meeting share one identity and team roster', async () => {
  const sam = getBotRow('sam');
  const text = await instructionsFor('owner', 'sam');
  const voice = voiceInstructions('owner', sam, 'auto', 'voice');
  const meeting = voiceInstructions('owner', sam, 'auto', 'meeting');
  for (const prompt of [text, voice, meeting]) {
    assert.match(prompt, /You are Sam Lee, Sales Development Rep\b.*\. You are an AI coworker on .*Dawnshift team/);
    assert.match(prompt, /- Trevor: Chief of Staff\. Assigns business requests\. \(main point of contact\)/);
    assert.match(prompt, /- Stacy Ross: Growth and Marketing Generalist/);
    assert.doesNotMatch(prompt, /Tyler Pilot|James Diaz|Team room|Grokbot/i);
  }
  assert.match(text, /bring them in with send_to_bot/);
  assert.match(voice, /bring them in by asking for it with send_task/);
  assert.doesNotMatch(meeting, /Luigi/, 'the Owner\'s name stays out of meetings');
  // The roster block is identical apart from how the Owner is named and how a teammate is brought in.
  const block = (s) => s.slice(s.indexOf('Your teammates:'), s.indexOf('You know who does what.'));
  assert.equal(block(text), block(voice));
  assert.equal(block(voice), block(meeting));
});

test('the Personal Assistant gets no roster and is never listed', () => {
  const james = identity(getBotRow('james'), 'owner', 'Luigi', 'with send_to_bot');
  assert.doesNotMatch(james, /teammates|Trevor|Sam Lee/);
  assert.match(james, /You are James Diaz, Personal Assistant\. You are an AI coworker on Luigi's Dawnshift team/);
});
