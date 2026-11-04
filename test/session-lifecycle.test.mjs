import test from 'node:test';
import assert from 'node:assert/strict';
import { PiBrokerSession } from '../src/session.mjs';

// Exercise the connector's orchestration without constructing transport or storage.
function fixture() {
  let metadata = { name: 'Initial' }, saved = { ...metadata }, unresolved = [];
  const calls = [];
  const session = Object.assign(Object.create(PiBrokerSession.prototype), {
    closed: false, hostSessionId: 'native', currentSessionId: () => 'native',
    operations: new Set(), operationController: new AbortController(),
    metadataNeedsReconcile: false, metadataRefreshRequested: false,
    metadataRefreshPromise: null, metadataController: null,
    recovery: null, recoveryController: null, readMetadata: () => metadata,
    onDiagnostic: event => calls.push(event.code),
    runtime: { stop: async options => calls.push(['stop', options]) },
    inbox: {
      getState: () => saved, unresolvedSends: () => unresolved,
      close: () => calls.push('inbox closed'),
    },
    client: {
      attachment: { lease_epoch: 1 },
      updateMetadata: async value => { calls.push(['update', value]); saved = value; },
      refreshOwnedMetadata: async () => calls.push('reconcile'),
    },
  });
  session.rootInbox = session.inbox;
  return { session, calls, rename: name => metadata = { name }, pending: values => unresolved = values };
}

test('metadata update failure reconciles before retry and remains pending until success', async () => {
  const f = fixture(), update = f.session.client.updateMetadata;
  f.rename('Renamed');
  f.session.client.updateMetadata = async () => { throw Error('lost response'); };
  await assert.rejects(f.session.refreshMetadata(), /lost response/);
  assert.equal(f.session.metadataSync, 'pending');
  assert.equal(f.session.metadataNeedsReconcile, true);
  f.session.client.updateMetadata = update;
  await f.session.refreshMetadata();
  assert.deepEqual(f.calls, ['reconcile', ['update', { name: 'Renamed' }]]);
  assert.equal(f.session.metadataSync, 'synced');
  assert.equal(f.session.metadataNeedsReconcile, false);
  await f.session.refreshMetadata();
  assert.equal(f.calls.length, 2, 'unchanged metadata must not cause another write');
});

test('concurrent metadata observations serialize and retain the latest value', async () => {
  const f = fixture(), update = f.session.client.updateMetadata;
  let release, began;
  const started = new Promise(resolve => began = resolve);
  f.session.client.updateMetadata = async value => {
    if (value.name === 'First') { began(); await new Promise(resolve => release = resolve); }
    await update(value);
  };
  f.rename('First'); const first = f.session.refreshMetadata(); await started;
  f.rename('Latest'); const second = f.session.refreshMetadata(); release();
  await Promise.all([first, second]);
  assert.deepEqual(f.calls, [['update', { name: 'First' }], ['update', { name: 'Latest' }]]);
  assert.deepEqual(f.session.metadata, { name: 'Latest' });
});

test('close aborts metadata work, drains it before storage close, and retains resumable identity', async () => {
  const f = fixture(); let began;
  const started = new Promise(resolve => began = resolve);
  f.session.client.updateMetadata = async (_value, { signal }) => {
    began();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      f.calls.push('metadata aborted'); reject(Error('aborted'));
    }, { once: true }));
  };
  f.rename('In flight'); const updating = assert.rejects(f.session.refreshMetadata(), /aborted/);
  await started; await f.session.close(); await updating; await f.session.close();
  assert.deepEqual(f.calls, ['metadata aborted', ['stop', { closeSession: false }], 'inbox closed']);
  assert.equal(f.session.operationController.signal.aborted, true);
  assert.equal(await f.session.refreshMetadata(), false);
  await assert.rejects(f.session.run(() => {}), { code: 'session_mismatch' });
});

test('outgoing recovery is bounded and coalesced; shutdown aborts and drains it', async () => {
  const f = fixture(); f.pending([{ key: 'existing intent' }]); let began;
  const started = new Promise(resolve => began = resolve);
  f.session.client.recoverOutgoing = async ({ limit, signal }) => {
    assert.equal(limit, 10); began();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      f.calls.push('recovery aborted'); reject(Error('aborted'));
    }, { once: true }));
  };
  await assert.rejects(f.session.recoverOutgoing({ budgetMs: 3001 }), { code: 'invalid_configuration' });
  const recovery = f.session.recoverOutgoing();
  const rejected = assert.rejects(recovery, /aborted/);
  assert.equal(f.session.recoverOutgoing(), recovery);
  await started; await f.session.close(); await rejected;
  assert.deepEqual(f.calls, ['recovery aborted', ['stop', { closeSession: false }], 'inbox closed']);
  assert.equal(f.session.recovery, null);
});

test('start replaces an expired incarnation only after the client confirms expiry', async () => {
  for (const confirmed of [false, true]) {
    const f = fixture(); let attempts = 0, replacements = 0;
    f.session.client.expiredIdentityConfirmed = confirmed;
    f.session.runtime.start = async () => {
      if (++attempts === 1) throw Object.assign(Error('expired'), { code: 'session_expired' });
      return 'started';
    };
    f.session.replaceExpiredIncarnation = async () => replacements++;
    if (confirmed) assert.equal(await f.session.start(), 'started');
    else await assert.rejects(f.session.start(), { code: 'session_expired' });
    assert.equal(replacements, confirmed ? 1 : 0);
    assert.equal(attempts, confirmed ? 2 : 1);
  }
});
