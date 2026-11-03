import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { storageLayout } from './storage.mjs';

const codes = new Set(['invalid_configuration', 'broker_origin_mismatch', 'storage_migration_required', 'storage_unavailable', 'selection_changed', 'session_mismatch', 'owner_conflict', 'native_input_unavailable', 'private_directory_required', 'private_file_required', 'invalid_approval_state', 'invalid_enrollment_receipt', 'credential_expired', 'approval_local_error', 'approval_busy', 'approval_capacity', 'approval_request_mismatch', 'approval_setup_required', 'approval_transport_error', 'https_origin_required', 'invalid_response', 'invalid_request', 'unauthenticated', 'forbidden', 'idempotency_conflict', 'rate_limited', 'not_ready', 'request_aborted', 'unsafe_storage_path']);
const phases = new Set(['selection_read', 'url_input', 'url_validation', 'approval_state_read', 'selection_write', 'enrollment_request', 'approved_attachment', 'approval_poll', 'storage_preflight', 'connection_start']);
// Read only supported native labels. Never inspect lock owners, paths or transcript contents.
export function ownershipConversation(ctx) {
  const read = fn => { try { return fn(); } catch { return undefined; } };
  const id = read(() => ctx.sessionManager.getSessionId());
  const shortId = typeof id === 'string' && id
    ? (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id) ? id.slice(0, 8) : createHash('sha256').update(id).digest('hex').slice(0, 8)) : 'unknown';
  const raw = read(() => ctx.sessionManager.getSessionName?.());
  // A path-shaped label is not needed to identify the conversation locally.
  const label = typeof raw === 'string' && !/[\\/]/.test(raw)
    ? [...raw.toWellFormed().replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, ' ')].slice(0, 64).join('').trim() : '';
  return `${label ? JSON.stringify(label) : 'Pi conversation'} [${shortId}]`;
}
export function setupDiagnostic(error, phase, requestState = 'not_started', ctx) {
  return { code: codes.has(error?.code) ? error.code : 'setup_failed', phase: phases.has(phase) ? phase : 'setup',
    requestState: ['not_started', 'intent_saved', 'outcome_unknown', 'pending', 'approved'].includes(requestState) ? requestState : 'outcome_unknown',
    ...(error?.code === 'owner_conflict' && ctx ? {conversation: ownershipConversation(ctx)} : {}) };
}
export function diagnosticText(diagnostic) {
  const {code, phase, requestState} = diagnostic;
  const advice = code === 'owner_conflict'
    ? `The inbox for ${diagnostic.conversation ?? 'this conversation'} could not acquire exclusive ownership; another active process is not confirmed. Select a different conversation, or close an existing owner normally only after confirming it. Use /psst-doctor for read-only checks; do not delete its lock or inbox or reset credentials.`
    : code === 'broker_origin_mismatch' || (code === 'invalid_configuration' && phase === 'url_validation') || code === 'https_origin_required'
      ? 'Use only the HTTPS broker origin, without a path/query or credentials; check a conflicting PSST_BROKER_URL override.'
      : 'Use /psst-doctor for read-only path checks. Preserve saved state; do not reset credentials to hide an uncertain result.';
  return `Psst setup diagnostic: ${code}; phase=${phase}; request=${requestState}. ${advice}`;
}

// Metadata only. No file contents, database opens, creation, chmod or network calls.
function inspect(path, target, kind, privateMode = true) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') return {target, code: 'path_unreadable'};
    let parent = dirname(path);
    while (true) {
      try { if (realpathSync(parent) !== parent) return {target, code: 'path_symlink'}; break; }
      catch (failure) { if (failure.code !== 'ENOENT') return {target, code: 'path_unreadable'}; }
      const next = dirname(parent); if (next === parent) break; parent = next;
    }
    return {target, code: 'missing'};
  }
  try {
    if (stat.isSymbolicLink() || realpathSync(path) !== path) return {target, code: 'path_symlink'};
    if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) return {target, code: 'wrong_path_type'};
    if (privateMode && (stat.mode & 0o077)) return {target, code: 'private_mode_required'};
    if (process.getuid && stat.uid !== process.getuid()) return {target, code: 'wrong_owner'};
    return {target, code: 'ok'};
  } catch { return {target, code: 'path_unreadable'}; }
}
export function inspectPsstStorage(env = process.env, home = homedir()) {
  const configured = env.PI_CODING_AGENT_DIR;
  const agent = configured ? resolve(configured === '~' ? home : configured.startsWith('~/') ? join(home, configured.slice(2)) : configured) : join(home, '.pi', 'agent');
  const root = join(agent, 'psst');
  const state = env.PSST_STATE_DIR ? resolve(env.PSST_STATE_DIR) : root;
  const installation = env.PSST_STATE_DIR ? join(state, 'installations') : join(root, 'installation-credentials');
  const checks = [inspect(root, 'selection_directory', 'directory'), inspect(join(root, 'selection.sqlite'), 'selection_file', 'file'),
    inspect(state, 'state_directory', 'directory'), inspect(installation, 'installation_directory', 'directory'),
    inspect(join(root, 'pi-config-path'), 'legacy_native_selection', 'file'),
    inspect(join(home, '.config', 'psst', 'pi-config-path'), 'legacy_selection', 'file')];
  try {
    const layout = storageLayout(env, home);
    if (layout.legacyStorage) checks.push(inspect(layout.stateDirectory, 'legacy_state_directory', 'directory'));
  } catch (error) { checks.push({target: 'storage_layout', code: error?.code === 'storage_migration_required' ? 'storage_migration_required' : 'invalid_configuration'}); }
  return checks;
}
export function doctorText(checks) {
  return `Read-only Psst path metadata: ${checks.map(({target, code}) => `${target}=${code}`).join('; ')}. Missing paths may be normal before setup. No file contents, credentials or databases were read or changed.`;
}
