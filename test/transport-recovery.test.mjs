import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installExtension } from '../src/extension.mjs';
import { PiBrokerSession } from '../src/session.mjs';
import { NativeDelivery } from '../src/native-delivery.mjs';
import { BrokerError } from '../vendor/broker/reference/client.mjs';
import { LocalError } from '../vendor/broker/reference/errors.mjs';
import { cardEnvelope } from './card-fixture.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const interrupted = () => new LocalError('request_failed', { effect: 'unknown', retryable: true });

// Controlled transport at BrokerClient.request: real registration/claim journals,
// runtime loops, Pi lifecycle and native receipt path, without sockets or a model.
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-reception-'));
  const file = join(root, 'native.jsonl'); writeFileSync(file, '');
  const config = { url: 'https://broker.example/', tokenFile: join(root, 'token'), stateDirectory: join(root, 'state'), name: 'Pi' };
  let now = Date.now(), sessionId = 'native-A', draft = '', selected = '/saved/connection.json';
  let online = true, state, poll, nextEnvelope, session, delivery, reconcileFailures = 0, loseCompletion = false;
  const claims = new Map(), timers = new Set(), requests = [], instances = [], notices = [], statuses = [], native = [], health = [];
  const sleep = (ms, _value, { signal } = {}) => new Promise((resolve, reject) => {
    const timer = { at: now + ms, finish: () => { timers.delete(timer); signal?.removeEventListener('abort', abort); resolve(); } };
    const abort = () => { timers.delete(timer); reject(new LocalError('request_aborted')); };
    if (signal?.aborted) { abort(); return; }
    timers.add(timer); signal?.addEventListener('abort', abort, { once: true });
  });
  const request = async (method, path, options = {}) => {
    requests.push({ method, path, ...options, at: now });
    if (!online) throw interrupted();
    if (path === '/v1/sessions') {
      const body = options.body;
      state = { ...body, lease_epoch: body.previous_epoch + 1, metadata_revision: 1,
        policy: { heartbeat_seconds: 1 }, connected: true, lease_expires_at: new Date(now + 60000).toISOString(), server_time: new Date(now).toISOString() };
      return state;
    }
    if (path === `/v1/sessions/${session.inbox.identity.client_id}`) {
      if (reconcileFailures > 0) { reconcileFailures--; throw interrupted(); }
      return state;
    }
    if (path.endsWith('/heartbeat')) {
      if (state.lease_epoch !== session.client.attachment.lease_epoch) throw new BrokerError(409, { error: { code: 'stale_lease_epoch' } });
      return { client_id: session.inbox.identity.client_id, lease_epoch: state.lease_epoch,
        lease_expires_at: new Date(now + 60000).toISOString(), server_time: new Date(now).toISOString() };
    }
    if (path === '/v1/mailbox/claim') {
      if (claims.has(options.key)) return claims.get(options.key);
      if (nextEnvelope) {
        const envelope = nextEnvelope; nextEnvelope = null;
        const claim = { claim_id: randomUUID(), lease_epoch: session.client.attachment.lease_epoch, attempt: 1,
          claim_expires_at: new Date(now + 60000).toISOString(), envelope };
        claims.set(options.key, claim); return claim;
      }
      return new Promise((resolve, reject) => {
        const signal = options.signal;
        const done = (error, value) => { signal?.removeEventListener('abort', abort); poll = null; error ? reject(error) : resolve(value); };
        const abort = () => done(new LocalError('request_aborted'));
        poll = { resolve: value => done(null, value), reject: error => done(error) };
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (path.endsWith('/complete')) {
      assert.equal(session.inbox.head()?.message_id, nextDeliveredId, 'durable inbox must precede broker delivered ACK');
      assert.equal(options.body.outcome, 'delivered');
      if (loseCompletion) { loseCompletion = false; throw interrupted(); }
      return {};
    }
    if (path === '/v1/messages') throw interrupted();
    assert.fail(`Unexpected transport call: ${method} ${path}`);
  };
  let nextDeliveredId;
  const events = {}, commands = {}, tools = {};
  const ctx = { hasUI: true, cwd: root, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => file },
    ui: { getEditorText: () => draft, notify: text => notices.push(text), setStatus: (_key, value) => statuses.push(value) } };
  t.mock.method(NativeDelivery.prototype, 'start', function () { delivery = this; });
  const Type = Object.fromEntries(['Object', 'String', 'Optional', 'Boolean', 'Integer'].map(key => [key, () => ({})]));
  installExtension({ on: (name, fn) => events[name] = fn, registerCommand: (name, value) => commands[name] = value,
    registerTool: tool => tools[tool.name] = tool, sendMessage: (message, options) => {
      native.push({ message, options }); appendFileSync(file, JSON.stringify({ type: 'custom_message', id: randomUUID(), ...message }) + '\n');
    } }, Type, { env: {}, configReader: () => config,
    pathStore: { read: () => selected, snapshot: () => ({ connectionFile: selected, brokerUrl: 'https://broker.example' }), isDisconnected: () => false,
      setDisconnected() {}, readPending: () => null },
    createSession: options => {
      session = new PiBrokerSession({ ...options, clientOptions: { now: () => now, random: () => 0.5 },
        onHealthChange: value => { health.push(value); options.onHealthChange(value); } });
      instances.push(session); session.runtime.sleep = sleep; session.runtime.random = () => 0.5; session.client.request = request;
      return session;
    } });
  t.after(async () => { await events.session_shutdown(); rmSync(root, { recursive: true, force: true }); });
  await events.session_start({}, ctx); await flush();
  return { events, commands, tools, ctx, requests, instances, notices, statuses, native, health, config,
    get session() { return session; }, get delivery() { return delivery; }, get now() { return now; }, get selected() { return selected; },
    setDraft: value => draft = value, setSession: value => sessionId = value,
    outage() { online = false; poll?.reject(interrupted()); },
    restart(failures = 0) { online = true; state.lease_epoch++; reconcileFailures = failures; },
    failReceiver(error = interrupted()) { poll.reject(error); },
    emptyPoll() { poll.resolve(null); },
    loseCompletion() { loseCompletion = true; },
    queue() {
      const envelope = { ...cardEnvelope('queued during outage'), message_id: randomUUID(), recipient_id: session.inbox.identity.client_id,
        accepted_at: new Date(now).toISOString(), expires_at: new Date(now + 86400000).toISOString() };
      nextDeliveredId = envelope.message_id; nextEnvelope = envelope; return envelope;
    },
    async step() {
      await flush(); assert.ok(timers.size, 'supervision must retain a scheduled wait');
      now = Math.max(now, Math.min(...[...timers].map(timer => timer.at)));
      for (const timer of [...timers]) if (timer.at <= now) timer.finish();
      await flush();
    },
    async until(predicate, limit = 60) {
      for (let i = 0; i < limit; i++) { await flush(); if (predicate()) return; await this.step(); }
      assert.fail('Recovery did not reach the required outcome within bounded supervision ticks');
    },
  };
}

test('outage/restart restores the same Pi mailbox and durable delivery without connect or a new send', async t => {
  const f = await fixture(t), owner = f.session, identity = { ...owner.inbox.identity }, inbox = owner.inbox;
  const operation = owner.client.prepareSend({ recipient_id: randomUUID(), content: { type: 'text/plain', text: 'uncertain send' }, ttl_seconds: 3600 }, { operationId: 'a'.repeat(64) });
  await assert.rejects(owner.client.sendPrepared(operation), { code: 'request_failed' });
  const pending = inbox.unresolvedSends();
  f.delivery.setHumanPaused(true); f.outage(); await flush();
  for (let i = 0; i < 8; i++) await f.step();
  assert.equal(f.requests.filter(row => row.path === '/v1/sessions').length, 1, 'no registrations while broker is unreachable');
  const envelope = f.queue(); f.restart();
  await f.until(() => inbox.head()?.message_id === envelope.message_id);
  assert.equal(f.instances.length, 1); assert.equal(f.session, owner); assert.equal(owner.inbox, inbox); assert.deepEqual(inbox.identity, identity);
  assert.deepEqual(inbox.unresolvedSends(), pending, 'transport recovery preserves the uncertain send key and outcome');
  assert.equal(f.requests.filter(row => row.path === '/v1/messages').length, 1, 'recovery does not create or resend a message');
  assert.equal(inbox.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 1);
  assert.equal(inbox.db.prepare('SELECT consumed_at FROM inbox').get().consumed_at, null);
  assert.equal(f.delivery.humanPaused, true); f.delivery.tick(); assert.equal(f.native.length, 0);
  f.delivery.setHumanPaused(false); f.setDraft('unfinished human input'); f.delivery.tick(); assert.equal(f.native.length, 0);
  f.setDraft(''); f.delivery.tick(); f.delivery.tick(); assert.equal(f.native.length, 1); assert.equal(inbox.head(), null);
  assert.deepEqual(f.native[0].options, { triggerTurn: true, deliverAs: 'followUp' });
  assert.match(inbox.db.prepare('SELECT native_receipt FROM inbox').get().native_receipt, /^pi:/);
  assert.equal(f.requests.some(row => row.path.endsWith('/acknowledge')), false);
  await f.commands['psst-status'].handler('', f.ctx);
  assert.match(f.notices.at(-1), /reception healthy/); assert.match(f.notices.at(-1), /recovery idle/);
  const result = await f.tools.broker_identity.execute('identity', {}, undefined, undefined, f.ctx);
  assert.equal(result.details.client_id, identity.client_id); assert.equal(result.details.transport.error_code, null);
});

test('an exhausted recovery round waits and a later heartbeat restores the same Pi receiver', async t => {
  const f = await fixture(t), owner = f.session, id = owner.inbox.identity.client_id;
  f.outage(); await flush(); const envelope = f.queue(); f.restart(4);
  await f.until(() => owner.inbox.head()?.message_id === envelope.message_id);
  const reads = f.requests.filter(row => row.method === 'GET').slice(1, 6);
  assert.equal(reads.length, 5, 'four failed reconciliations span more than the three-attempt round');
  assert.ok(reads.every((row, index) => !index || row.at > reads[index - 1].at), 'attempts and subsequent rounds must be spaced out');
  assert.equal(f.session, owner); assert.equal(owner.inbox.identity.client_id, id); assert.equal(f.instances.length, 1);
  assert.equal(owner.runtime.status().recovery, 'idle');
});

test('receiver-only interruption recovers under successful heartbeats; an empty poll and in-flight poll are healthy', async t => {
  const f = await fixture(t), id = f.session.inbox.identity.client_id;
  f.emptyPoll(); await flush();
  for (let i = 0; i < 4; i++) await f.step();
  assert.equal(f.requests.filter(row => row.path === '/v1/sessions').length, 1, 'ordinary long poll must not renew the lease');
  const pendingClaim = f.session.inbox.getState('claim_pending');
  f.failReceiver(); await flush(); const envelope = f.queue();
  await f.until(() => f.session.inbox.head()?.message_id === envelope.message_id);
  assert.equal(f.instances.length, 1); assert.equal(f.session.inbox.identity.client_id, id);
  assert.equal(f.session.runtime.status().reception, 'healthy');
  assert.equal(f.session.runtime.status().recovery, 'idle');
  assert.equal(f.requests.filter(row => row.path === '/v1/mailbox/claim').at(-2).key, pendingClaim.key);
  assert.ok(f.health.some(value => value.recovery === 'retry_waiting'));
  assert.match(f.statuses.at(-1), /reception healthy/);
});

test('ambiguous delivered completion retries the original claim without duplicate inbox storage or native turns', async t => {
  const f = await fixture(t), envelope = f.queue(); f.loseCompletion(); f.emptyPoll(); await flush();
  assert.equal(f.session.inbox.head()?.message_id, envelope.message_id);
  const pendingClaim = f.session.inbox.getState('claim_pending');
  await f.until(() => f.session.runtime.status().recovery === 'idle');
  const completions = f.requests.filter(row => row.path.endsWith('/complete'));
  assert.equal(completions.length, 2); assert.deepEqual(completions[0].body, completions[1].body);
  const repeatedClaims = f.requests.filter(row => row.path === '/v1/mailbox/claim' && row.key === pendingClaim.key);
  assert.equal(repeatedClaims.length, 2);
  assert.equal(f.session.inbox.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 1);
  assert.equal(f.native.length, 0); f.delivery.tick(); f.delivery.tick(); assert.equal(f.native.length, 1);
  assert.equal(f.requests.some(row => row.path === '/v1/messages' || row.path.endsWith('/acknowledge')), false);
});

for (const transition of ['shutdown', 'disconnect', 'session change']) test(`${transition} fences scheduled Pi recovery`, async t => {
  const f = await fixture(t); f.outage(); await flush();
  if (transition === 'session change') f.setSession('native-B');
  else if (transition === 'disconnect') await f.commands['psst-disconnect'].handler('', f.ctx);
  else await f.events.session_shutdown();
  f.restart();
  if (transition === 'session change') await f.step();
  await flush();
  const count = f.requests.length; await flush();
  assert.equal(f.requests.length, count); assert.equal(f.instances.length, 1); assert.equal(f.native.length, 0);
  assert.equal(f.session.runtime.closed, true);
});

for (const code of ['unauthenticated', 'session_mismatch', 'session_expired', 'invalid_response', 'storage_unavailable']) test(`${code} remains blocked without changing Pi authorization or mailbox`, async t => {
  const f = await fixture(t), inbox = f.session.inbox, identity = { ...inbox.identity }, selected = f.selected;
  f.failReceiver(new LocalError(code, { effect: 'unknown', retryable: code === 'storage_unavailable' })); await flush();
  const calls = f.requests.length; await flush(); assert.equal(f.requests.length, calls);
  assert.equal(f.instances.length, 1); assert.deepEqual(inbox.identity, identity); assert.equal(f.selected, selected);
  assert.equal(f.requests.filter(row => row.path === '/v1/sessions').length, 1);
  assert.equal(f.session.deliveryAllowed(), false); assert.equal(f.native.length, 0);
  assert.equal(f.session.runtime.status().recovery, 'blocked');
});
