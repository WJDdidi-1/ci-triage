/**
 * Self-check: `ci-triage doctor`.
 *
 * The method is Claude Code's `claude doctor`, as used by
 * dev-diagnosis: one read-only command that answers "is my setup
 * healthy?" instead of making the user debug each piece by hand.
 * The terminal form changes nothing — it only reports, with a
 * copy-paste fix per failure — so it works even when the rest of
 * the tool is misbehaving. The checks are the failure modes from
 * our own history:
 *
 * - node: engines says >= 18; a too-old Node fails everything before
 *   it starts.
 * - command: is `ci-triage` resolvable on PATH? Inside the ci-triage
 *   source repo itself the fix is different (npx resolves the local
 *   package, which has no node_modules/.bin — the same quirk
 *   dev-diagnosis documents in its README Troubleshooting entry),
 *   so that case gets its own fix.
 * - home: $HOME vs os.homedir() — the disagreement behind
 *   dev-diagnosis 0.2.0's wrong-HOME bug. --skill-generate --global
 *   writes under resolveHome() ($HOME when set); if the OS reports
 *   a different home, the user is looking in the wrong place.
 * - skill: is a SKILL.md installed (project or global), and is its
 *   frontmatter valid? A broken frontmatter (name not matching the
 *   directory, description over the spec's limit) makes the skill
 *   silently never trigger, so existence alone is not enough.
 *   Advisory — the CLI works without it.
 * - token: is there a token (GH_TOKEN, GITHUB_TOKEN, or `gh auth`)?
 *   Advisory, not a failure — the triage still runs without one,
 *   but GitHub does not allow anonymous job-log downloads, so
 *   without a token it can list the failed runs and jobs and read
 *   none of their logs. Our own dogfood on WJDdidi-1/dev-doctor
 *   came back UNKNOWN with 13 unreadable jobs for exactly this
 *   reason. The detail names the token's source, never the token
 *   itself — like `gh auth status`, which hides the token unless
 *   asked with --show-token (we never ask).
 * - api: one cheap GET on the API root, with the token when there
 *   is one — the same single-call validation `gh auth login`
 *   performs (it calls the API and reads the scopes back). A 401
 *   means the token is rejected, which is a failure: every triage
 *   run would fail the same way. Unreachable is a warning — the
 *   network may be transient, and the tool itself is not broken.
 *   The rate-limit budget from the response headers is reported so
 *   the user sees how much API headroom the token has.
 *
 * No version check: ci-triage makes no network call except to the
 * GitHub API, and a version check would need a second host.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiBase, resolveToken } from './github.mjs';
import { resolveHome } from './home.mjs';
import { skillPath, validateSkillMd, SKILL_DIR_NAME } from './skill.mjs';

export const MIN_NODE_MAJOR = 18;

// One check: { id, name, status: 'ok' | 'warn' | 'fail', detail, fix? }.
// Warnings never fail the run — they are for optional wiring (skill,
// token, API reachability). Failures are for things the tool itself
// needs.
export async function runDoctor(options = {}) {
  const home = options.home || resolveHome();
  const pathEnv = options.pathEnv !== undefined ? options.pathEnv : process.env.PATH || '';
  const cwd = options.cwd || process.cwd();
  const nodeVersion = options.nodeVersion || process.version;
  // os.homedir() is injectable for tests: on POSIX it honours $HOME,
  // so a mismatch can only be produced on Windows (where it reads
  // the profile instead) — the test passes a different value in.
  const osHome = options.osHome || os.homedir();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const base = (options.apiBase || apiBase()).replace(/\/$/, '');
  const checks = [];

  // Node: the engines floor. A too-old Node fails every check before
  // it starts, so this one is a failure, not a warning.
  const major = Number.parseInt(String(nodeVersion).replace(/^v/, '').split('.')[0], 10);
  checks.push(Number.isFinite(major) && major >= MIN_NODE_MAJOR
    ? { id: 'node', name: 'Node.js', status: 'ok', detail: `${nodeVersion} (>= ${MIN_NODE_MAJOR})` }
    : {
      id: 'node', name: 'Node.js', status: 'fail',
      detail: `${nodeVersion} is below the minimum ${MIN_NODE_MAJOR}`,
      fix: 'Install Node.js 18 or newer: https://nodejs.org',
    });

  // Command: is ci-triage itself on PATH? A small lookup of our own
  // (ci-triage has no path check of its own to reuse): scan PATH for
  // an executable `ci-triage`, plus the .cmd/.exe forms on Windows.
  const found = lookupCommand('ci-triage', pathEnv);
  if (found.resolved) {
    checks.push({ id: 'command', name: 'Command', status: 'ok', detail: `ci-triage resolves to ${found.path}` });
  } else {
    // Inside the source repo the installed command is the wrong fix:
    // npx resolves the local package, which has no node_modules/.bin
    // — run the local bin.
    let inSourceRepo = false;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      inSourceRepo = pkg.name === 'ci-triage-cli';
    } catch { inSourceRepo = false; }
    checks.push({
      id: 'command', name: 'Command', status: 'fail',
      detail: `ci-triage is not on PATH (${found.reason})`,
      fix: inSourceRepo
        ? 'You are inside the ci-triage source repo: run node bin/ci-triage.js here, or install it globally with npm install -g ci-triage-cli'
        : 'Install it globally: npm install -g ci-triage-cli (or run one-off with npx ci-triage-cli)',
    });
  }

  // Home: the directory --skill-generate --global writes into. Two
  // failure modes: it is not writable, or $HOME and os.homedir()
  // disagree — the 0.2.0 bug was exactly that disagreement, with
  // files landing where the user was not looking.
  const envHome = process.env.HOME;
  let homeCheck;
  try {
    fs.accessSync(home, fs.constants.W_OK);
    homeCheck = { id: 'home', name: 'Home', status: 'ok', detail: `home resolves to ${home}` };
  } catch {
    homeCheck = {
      id: 'home', name: 'Home', status: 'fail',
      detail: `home directory is not writable: ${home}`,
      fix: 'Point HOME at a writable directory, or fix the permissions on it',
    };
  }
  if (homeCheck.status === 'ok' && envHome && envHome !== osHome) {
    homeCheck = {
      id: 'home', name: 'Home', status: 'warn',
      detail: `HOME=${envHome} but os.homedir()=${osHome} — --skill-generate --global writes under HOME`,
      fix: `If the files land somewhere unexpected, check ${envHome} first`,
    };
  }
  checks.push(homeCheck);

  // Skill: advisory — the CLI works without it, but an agent that
  // never finds the skill never runs the tool. Existence is not
  // enough: a broken frontmatter makes the skill silently never
  // trigger, so the installed file is validated too. A broken skill
  // warns (it never fails the run) and names the first problem.
  const projectSkill = skillPath('project', cwd);
  const globalSkill = skillPath('global');
  const foundSkill = fs.existsSync(projectSkill)
    ? { scope: 'project', path: projectSkill }
    : (fs.existsSync(globalSkill) ? { scope: 'global', path: globalSkill } : null);
  if (foundSkill === null) {
    checks.push({
      id: 'skill', name: 'Skill', status: 'warn',
      detail: 'no SKILL.md installed (project or global)',
      fix: 'Run ci-triage --skill-generate in a repo, or --skill-generate --global for every repo',
    });
  } else {
    let validation;
    try {
      validation = validateSkillMd(fs.readFileSync(foundSkill.path, 'utf8'), SKILL_DIR_NAME);
    } catch {
      validation = { valid: false, problems: ['could not read SKILL.md'] };
    }
    if (validation.valid) {
      checks.push({ id: 'skill', name: 'Skill', status: 'ok', detail: `${foundSkill.scope} skill installed and valid: ${foundSkill.path}` });
    } else {
      const first = validation.problems[0];
      const more = validation.problems.length > 1 ? ` (+${validation.problems.length - 1} more)` : '';
      checks.push({
        id: 'skill', name: 'Skill', status: 'warn',
        detail: `${foundSkill.scope} skill is invalid: ${first}${more}`,
        fix: 'Fix the SKILL.md frontmatter (name must match the skill directory, description 1–1024 chars, no < or >), or delete it and re-run ci-triage --skill-generate',
      });
    }
  }

  // Token: GH_TOKEN, then GITHUB_TOKEN, then `gh auth token` — the
  // same order the API client resolves it in. The source is named,
  // the value never is. Tests inject `token` (undefined means
  // resolve live) and `tokenSource` to skip the `gh` spawn.
  let token = options.token;
  let tokenSource = options.tokenSource;
  if (token === undefined) {
    if (process.env.GH_TOKEN) {
      token = process.env.GH_TOKEN;
      tokenSource = 'GH_TOKEN';
    } else if (process.env.GITHUB_TOKEN) {
      token = process.env.GITHUB_TOKEN;
      tokenSource = 'GITHUB_TOKEN';
    } else {
      token = resolveToken();
      tokenSource = token ? 'gh auth' : null;
    }
  }
  if (token) {
    checks.push({ id: 'token', name: 'Token', status: 'ok', detail: `token available via ${tokenSource || 'environment'}` });
  } else {
    checks.push({
      id: 'token', name: 'Token', status: 'warn',
      detail: 'no token found — triage can list failed runs and jobs but cannot download their logs',
      fix: 'Set GH_TOKEN (export GH_TOKEN=... — a classic PAT with repo scope, or a fine-grained token with Actions: read) or run `gh auth login`',
    });
  }

  // API: one GET on the API root, with the token when there is one.
  // 401 is a failure — the token is rejected and every triage run
  // would fail the same way. Anything else that is not a 200 is a
  // warning: the tool itself is fine, the service or the network
  // is not.
  checks.push(await checkApi({ fetchImpl, base, token }));

  const failed = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  return { checks, passed: failed === 0, failed, warnings };
}

async function checkApi({ fetchImpl, base, token }) {
  const name = 'GitHub API';
  let res;
  try {
    const headers = {
      accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'user-agent': 'ci-triage',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    res = await fetchImpl(`${base}/`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    return {
      id: 'api', name, status: 'warn',
      detail: `could not reach the GitHub API (${error.message})`,
      fix: 'Check your network connection and try again',
    };
  }
  if (res.status === 401) {
    return {
      id: 'api', name, status: 'fail',
      detail: 'GitHub rejected the token (401)',
      fix: 'Check GH_TOKEN, or run `gh auth login` again',
    };
  }
  if (!res.ok) {
    return {
      id: 'api', name, status: 'warn',
      detail: `GitHub API returned ${res.status} for ${base}/`,
      fix: 'Check https://www.githubstatus.com and try again',
    };
  }
  const remaining = res.headers?.get?.('x-ratelimit-remaining');
  const limit = res.headers?.get?.('x-ratelimit-limit');
  const budget = remaining !== null && remaining !== undefined && limit
    ? ` (${remaining}/${limit} requests left this hour)`
    : '';
  return {
    id: 'api', name, status: 'ok',
    detail: token
      ? `reachable, token accepted${budget}`
      : `reachable (anonymous — 60 requests/hour)${budget}`,
  };
}

// Scan PATH for an executable command. Returns { resolved, path?,
// reason? } — the same shape a caller needs to say why it failed:
// missing entirely, or present but not executable.
export function lookupCommand(name, pathEnv) {
  const dirs = String(pathEnv || '').split(path.delimiter).filter(Boolean);
  const candidates = process.platform === 'win32'
    ? [name, `${name}.cmd`, `${name}.exe`]
    : [name];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        if (process.platform !== 'win32') fs.accessSync(full, fs.constants.X_OK);
        return { resolved: true, path: full };
      } catch { /* not this one — keep looking */ }
    }
  }
  return { resolved: false, reason: `no executable ${name} found on PATH` };
}
