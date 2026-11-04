import { renameSync, writeFileSync } from 'node:fs';

// The PTY observer runs in another process. A direct overwrite exposes truncated
// JSON between open/truncate and write, which can turn a valid state into {}.
export function writeObservation(path, state) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, path);
}
