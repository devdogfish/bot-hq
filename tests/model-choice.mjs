import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'loopback-test-only';
const { turnModel } = await import('../server/dist/agent/model-choice.js');
const { toProviders } = await import('../server/dist/engine.js');
const { db } = await import('../server/dist/db.js');
const { getBot } = await import('../server/dist/store.js');

const bot = { model: 'claude-opus-4-7', provider: 'anthropic', chat_model: 'claude-sonnet-4-6', chat_provider: 'anthropic' };

test('direct chat uses the chat model; every other turn keeps production', () => {
  assert.deepEqual(turnModel(bot, true), { model: 'claude-sonnet-4-6', provider: 'anthropic' });
  assert.deepEqual(turnModel(bot, false), { model: 'claude-opus-4-7', provider: 'anthropic' });
});

test('no chat model falls back to production, and no production model to the gateway default', () => {
  assert.deepEqual(turnModel({ model: 'gpt-5.5', provider: 'openai-codex' }, true), { model: 'gpt-5.5', provider: 'openai-codex' });
  assert.deepEqual(turnModel({}, true), { model: 'hermes-agent' });
});

test('a chat model never borrows the production provider', () => {
  assert.deepEqual(turnModel({ model: 'claude-opus-4-7', provider: 'anthropic', chat_model: 'custom-id' }, true), { model: 'custom-id' });
});

test('providers: connected first, all models up to the cap, aggregators use featured models', () => {
  const many = Array.from({ length: 30 }, (_, i) => `m-${i}`);
  const list = toProviders({ providers: [
    { slug: 'openrouter', name: 'OpenRouter', authenticated: false, models: many, featured_models: ['anthropic/claude-sonnet-4.6'] },
    { slug: 'anthropic', name: 'Anthropic', authenticated: true, auth_type: 'api_key', models: ['claude-opus-4-7', 'claude-sonnet-4-6'] },
    { slug: 'openai-codex', name: 'Codex', authenticated: true, auth_type: 'oauth', models: many },
    { slug: 'obscure', name: 'Obscure', authenticated: false, models: ['x'] },
  ] });
  assert.deepEqual(list.map((p) => p.id), ['anthropic', 'openai-codex', 'openrouter']);
  assert.equal(list[0].name, 'Claude (Anthropic)');
  assert.ok(list[0].models.includes('claude-sonnet-4-6'));
  assert.equal(list[1].kind, 'subscription');
  assert.equal(list[1].models.length, 24);
  assert.deepEqual(list[2].models, ['anthropic/claude-sonnet-4.6']);
});

test('chat model columns reach the Bot record', () => {
  db.exec(`INSERT INTO users (id, email, name, created_at) VALUES ('u', 'u@example.test', 'U', 0);
    INSERT INTO bots (id, user_id, name, created_at, updated_at, model, provider, chat_model, chat_provider)
    VALUES ('b', 'u', 'Tyler', 0, 0, 'claude-opus-4-7', 'anthropic', 'claude-sonnet-4-6', 'anthropic');`);
  const b = getBot('b');
  assert.equal(b.model, 'claude-opus-4-7');
  assert.equal(b.chatModel, 'claude-sonnet-4-6');
  assert.equal(b.chatProvider, 'anthropic');
});
