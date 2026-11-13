/**
 * Shared test helpers.
 *
 * tempDir() is mkdtempSync with cleanup: the directory is removed
 * after the test that created it, so repeated suite runs cannot fill
 * /tmp (a 512 MB tmpfs on this machine). The `after` hook runs even
 * when the test fails, so a failing test still cleans up after
 * itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

export function tempDir(prefix) {
  // Canonicalise the path: on macOS os.tmpdir() is under /var, a
  // symlink to /private/var, and a child process reports its working
  // directory by the real path — a test comparing a printed path with
  // the mkdtemp spelling would otherwise fail on the /var prefix.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
