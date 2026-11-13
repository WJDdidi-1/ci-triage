/**
 * The user's home directory, honouring $HOME when it is set.
 *
 * os.homedir() ignores $HOME on Windows — it reads the profile from
 * the system instead — so a caller that points HOME at another
 * directory (a test sandbox, or a user running under Git Bash with
 * HOME set) would be silently ignored. Prefer $HOME when present,
 * which is also what os.homedir() already does on POSIX.
 */
import os from 'node:os';

export function resolveHome() {
  return process.env.HOME || os.homedir();
}
