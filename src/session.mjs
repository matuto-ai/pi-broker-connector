import { mkdirSync, writeFileSync, lstatSync, realpathSync, openSync, closeSync, fsyncSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Inbox, newSessionIdentity } from '../vendor/broker/reference/inbox.mjs';
import { BrokerClient } from '../vendor/broker/reference/client.mjs';
import { AdapterRuntime } from '../vendor/broker/reference/runtime.mjs';
import { LocalError } from '../vendor/broker/reference/errors.mjs';
import { readPrivateJson } from './config.mjs';
import { canonical, validateMetadata, validateUuid } from '../vendor/broker/src/protocol.mjs';

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw new LocalError('invalid_configuration');
}

/** One native Pi session, one durable identity. Reload/resume reconnects it. */
export class PiBrokerSession {
  constructor({ config, hostSessionId, currentSessionId, observeMetadata, onDiagnostic = () => {}, clientOptions = {} }) {
    if (typeof hostSessionId !== 'string' || !hostSessionId || hostSessionId.length > 256) throw new LocalError('session_mismatch');
    this.hostSessionId = hostSessionId;
    this.currentSessionId = currentSessionId;
    this.closed = false;
    this.operations = new Set();
    this.operationController = new AbortController();
    this.onDiagnostic = onDiagnostic;
    this.recovery = null; this.recoveryController = null;
    this.config = config;
    this.clientOptions = clientOptions;
    this.observeMetadata = observeMetadata;
    this.observedMetadata = null;
    this.metadataSync = 'pending';
    this.metadataNeedsReconcile = false;
    this.metadataRefreshPromise = null;
    this.metadataRefreshRequested = false;
    this.metadataController = null;
    const root = resolve(config.stateDirectory); privateDirectory(root);
    // Endpoint and native-session binding prevent state adoption across brokers/sessions.
    const binding = createHash('sha256').update(JSON.stringify(config.credentialId ? [config.url, hostSessionId, config.credentialId] : [config.url, hostSessionId])).digest('hex');
    this.directory = join(root, binding); privateDirectory(this.directory);
    const identityFile = join(this.directory, 'identity.json');
    try { writeFileSync(identityFile, JSON.stringify({ hostSessionId, brokerUrl: config.url, ...(config.credentialId ? {credentialId:config.credentialId} : {}), identity: newSessionIdentity('pi') }), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const saved = readPrivateJson(identityFile);
    if (saved.hostSessionId !== hostSessionId || saved.brokerUrl !== config.url || saved.identity?.client_type !== 'pi' || saved.credentialId !== config.credentialId) throw new LocalError('session_mismatch');
    this.rootBinding = {hostSessionId, brokerUrl: config.url, ...(config.credentialId ? {credentialId:config.credentialId} : {})};
    this.pointerFile = join(this.directory, 'current-incarnation.json');
    // Keep the original lock: an older connector must not concurrently own root.
    this.rootInbox = new Inbox({ directory: this.directory, identity: saved.identity, ...(clientOptions.now ? {now:clientOptions.now} : {}) });
    this.inbox = this.rootInbox;
    try {
      let pointer;
      try { lstatSync(this.pointerFile); pointer = readPrivateJson(this.pointerFile); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (pointer) {
        if ((clientOptions.registrationVersion ?? config.registrationVersion ?? 1) !== 2
          || pointer.format !== 'pi-incarnation-v1' || pointer.identity?.client_type !== 'pi'
          || Object.keys(pointer.identity).sort().join(',') !== 'client_id,client_type,session_instance_id'
          || canonical(pointer.binding) !== canonical(this.rootBinding)
          || pointer.directory !== `incarnation-${validateUuid(pointer.identity?.client_id)}`) throw new LocalError('session_mismatch');
        const directory = join(this.directory, pointer.directory);
        // A pointer is never authority to recreate a missing journal.
        lstatSync(join(directory, 'inbox.sqlite'));
        this.inbox = new Inbox({directory, identity:pointer.identity, ...(clientOptions.now ? {now:clientOptions.now} : {})});
      }
      this.buildTransport();
    } catch (error) { if (this.inbox !== this.rootInbox) this.inbox.close(); this.rootInbox.close(); throw error; }
  }
  buildTransport() {
    const config = this.config;
    this.client = new BrokerClient({url:config.url, tokenFile:config.tokenFile, caFile:config.caFile,
      inbox:this.inbox, requestTimeoutMs:40000, registrationVersion:config.registrationVersion ?? 1, ...this.clientOptions});
    this.runtime = new AdapterRuntime({client:this.client, verifySession:()=>this.isAlive(), isAlive:()=>this.isAlive(),
      onDiagnostic:this.onDiagnostic, closeOnLostSession:false});
  }
  async replaceExpiredIncarnation() {
    if (!this.isAlive() || this.client.registrationVersion !== 2 || !this.client.expiredIdentityConfirmed) throw new LocalError('session_mismatch');
    await this.runtime.stop({closeSession:false});
    if (!this.isAlive()) throw new LocalError('session_mismatch');
    const oldInbox = this.inbox;
    // Temporary allocation name is independent of identity; final name is chosen only after creation.
    const temporary = join(this.directory, `new-${randomUUID()}`);
    const replacement = await this.client.createReplacementInbox({directory:temporary, verifySession:()=>this.isAlive()});
    const identity = replacement.identity;
    replacement.close();
    const directoryName = `incarnation-${identity.client_id}`;
    const directory = join(this.directory, directoryName);
    renameSync(temporary, directory);
    let next;
    try {
      next = new Inbox({directory,identity,...(this.clientOptions.now ? {now:this.clientOptions.now} : {})});
      if (!this.isAlive()) throw new LocalError('session_mismatch');
      const childDir = openSync(directory,'r'); try { fsyncSync(childDir); } finally { closeSync(childDir); }
      const pointer = {format:'pi-incarnation-v1',binding:this.rootBinding,directory:directoryName,identity};
      const temporaryPointer = join(this.directory, `.incarnation-${randomUUID()}.tmp`);
      let fd;
      try {
        fd = openSync(temporaryPointer, 'wx', 0o600); writeFileSync(fd, JSON.stringify(pointer)); fsyncSync(fd);
      } finally { if (fd !== undefined) closeSync(fd); }
      renameSync(temporaryPointer, this.pointerFile);
      // Child database creation and pointer rename must precede any new registration.
      for (const path of [this.directory]) { const dir = openSync(path,'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
      this.inbox = next;
      if (oldInbox !== this.rootInbox) oldInbox.close();
      this.buildTransport();
    } catch (error) { next?.close(); throw error; }
  }
  isAlive() { return !this.closed && this.currentSessionId() === this.hostSessionId; }
  deliveryAllowed() { return this.isAlive() && !this.runtime.paused && !this.runtime.closed; }
  readMetadata() {
    return validateMetadata(this.observeMetadata ? this.observeMetadata(this.inbox.identity)
      : { name: this.config.name, model: { provider: null, id: null, source: 'unknown' }, project: null });
  }
  get metadata() { return this.observedMetadata ?? this.readMetadata(); }
  async start() {
    this.observedMetadata = this.readMetadata();
    let result;
    try { result = await this.runtime.start(this.observedMetadata); }
    catch (error) {
      if (error.code !== 'session_expired' || !this.client.expiredIdentityConfirmed) throw error;
      await this.replaceExpiredIncarnation();
      this.observedMetadata = this.readMetadata();
      result = await this.runtime.start(this.observedMetadata);
    }
    this.metadataSync = 'synced';
    void this.recoverOutgoing().catch(() => { if (this.isAlive()) this.recoveryDiagnostic(); });
    return result;
  }
  async refreshMetadata() {
    if (!this.isAlive() || !this.client.attachment.lease_epoch) return false;
    this.metadataRefreshRequested = true;
    if (this.metadataRefreshPromise) return this.metadataRefreshPromise;
    const controller = new AbortController();
    this.metadataController = controller;
    // Metadata is descriptive; a failed update must not stall transport tools or
    // shutdown behind the normal long-poll request timeout.
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]);
    const pending = this.run(async () => {
      while (this.metadataRefreshRequested && this.isAlive()) {
        this.metadataRefreshRequested = false;
        const desired = this.readMetadata();
        this.observedMetadata = desired;
        this.metadataSync = 'pending';
        try {
          // A lost PATCH response may have applied. Reconcile ownership and revision
          // before another mutation; never blindly retry a stale compare-and-swap.
          if (this.metadataNeedsReconcile) await this.client.refreshOwnedMetadata({ signal });
          if (!this.isAlive()) return false;
          if (canonical(this.inbox.getState('metadata')) !== canonical(desired)) {
            await this.client.updateMetadata(desired, { signal });
          }
          this.metadataNeedsReconcile = false;
          this.metadataSync = 'synced';
        } catch (error) {
          this.metadataNeedsReconcile = true;
          throw error;
        }
      }
      return true;
    });
    this.metadataRefreshPromise = pending;
    try { return await pending; }
    finally {
      if (this.metadataRefreshPromise === pending) this.metadataRefreshPromise = null;
      if (this.metadataController === controller) this.metadataController = null;
    }
  }
  recoveryDiagnostic() { try { this.onDiagnostic({code:'outgoing_recovery_pending'}); } catch { /* Diagnostics never break recovery. */ } }
  recoverOutgoing({ budgetMs = 3000 } = {}) {
    if (this.recovery) return this.recovery;
    if (!this.isAlive()) return Promise.reject(new LocalError('session_mismatch'));
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 3000) return Promise.reject(new LocalError('invalid_configuration'));
    if (!this.inbox.unresolvedSends().length) return Promise.resolve([]);
    const controller = new AbortController(); this.recoveryController = controller;
    const timer = setTimeout(() => controller.abort(), budgetMs);
    this.recovery = this.run(async () => {
      const result = await this.client.recoverOutgoing({limit:10,signal:controller.signal});
      if (this.isAlive() && this.inbox.unresolvedSends().length) this.recoveryDiagnostic();
      return result;
    }).finally(() => { clearTimeout(timer); this.recovery = null; this.recoveryController = null; });
    return this.recovery;
  }
  async run(operation) {
    if (!this.isAlive()) throw new LocalError('session_mismatch');
    const work = Promise.resolve().then(operation);
    this.operations.add(work);
    try { return await work; } finally { this.operations.delete(work); }
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.metadataController?.abort();
    this.operationController.abort();
    this.recoveryController?.abort();
    this.closePromise = (async () => {
      // Preserve broker identity on /reload or /resume. Capable brokers end the
      // lease resumably; older brokers expire it. The same native identity returns.
      await this.runtime.stop({ closeSession: false });
      await Promise.allSettled([...this.operations]);
      this.inbox.close();
      if (this.rootInbox !== this.inbox) this.rootInbox.close();
    })();
    return this.closePromise;
  }
}
