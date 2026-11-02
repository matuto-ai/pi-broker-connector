import { basename } from 'node:path';

export const DEFAULT_PROJECT_ENV = 'AI_AGENTS_SANDBOX_PROJECT_NAME';
const unsafe = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
function label(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.isWellFormed() || [...value].length > 256 || unsafe.test(value)) throw Error('invalid_project_metadata');
  return value.trim() || null;
}
/** Local operator settings only; never accept an environment selector from a peer/tool. */
export function projectMetadata(config = {}, env = process.env, cwd) {
  const explicit = label(config.project);
  if (explicit !== null) return explicit;
  const key = env.PSST_PROJECT_ENV ?? config.projectEnv ?? DEFAULT_PROJECT_ENV;
  if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw Error('invalid_project_environment');
  const selected = label(env[key]);
  if (selected !== null) return selected;
  if (typeof cwd !== 'string') return null;
  const fallback = label(basename(cwd.replaceAll('\\', '/')));
  return fallback === '.' || fallback === '..' ? null : fallback;
}
