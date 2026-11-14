import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from '../scripts/support.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ci-triage.js');
const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', ...options });
}

// A fake ci-triage binary on PATH: detection only checks that the
// file exists and is executable. On Windows a bare name is never
// executable — lookup tries the .cmd/.exe forms — so the fake is a
// .cmd file there. It is never run, so the content does not matter.
function writeFakeBinary(dir, name) {
  const file = process.platform === 'win32'
    ? path.join(dir, `${name}.cmd`)
    : path.join(dir, name);
  fs.writeFileSync(file, process.platform === 'win32' ? '@echo off\n' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
}

// Env for a sandboxed run: HOME points at a temp dir (so no real
// config is ever read), PATH is exactly the given bin dir (so the
// command check sees only what the test put there, and `gh` is not
// found, so the token check warns).
function envFor(home, binDir, cwd) {
  const env = { ...process.env, HOME: home, PATH: binDir };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  if (process.platform === 'win32') {
    env.APPDATA = path.join(home, 'AppData', 'Roaming');
  }
  return { env, cwd };
}

function snapshot(dir) {
  return fs.readdirSync(dir).sort();
}

// A stub fetch for the API check: { status, remaining, limit } or an
// Error to throw. The headers object only needs .get().
function stubFetch({ status = 200, remaining = '4999', limit = '5000' } = {}) {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => {
        if (name === 'x-ratelimit-remaining') return remaining;
        if (name === 'x-ratelimit-limit') return limit;
        return null;
      },
    },
  });
}

test('doctor: node version below the floor fails (unit level)', async () => {
  const result = await runDoctor({ nodeVersion: 'v16.20.0', token: null, fetchImpl: stubFetch() });
  const node = result.checks.find((check) => check.id === 'node');
  assert.equal(node.status, 'fail');
  assert.match(node.fix, /Node\.js 18/);
  assert.equal(result.passed, false);
  const current = await runDoctor({ nodeVersion: process.version, token: null, fetchImpl: stubFetch() });
  assert.equal(current.checks.find((check) => check.id === 'node').status, 'ok');
});

test('doctor: HOME disagreeing with os.homedir() warns (unit level)', async () => {
  // On POSIX os.homedir() honours $HOME, so a mismatch can only
  // happen on Windows (where it reads the profile) — inject it.
  const result = await runDoctor({ osHome: '/definitely-not-home', token: null, fetchImpl: stubFetch() });
  const home = result.checks.find((check) => check.id === 'home');
  assert.equal(home.status, 'warn');
  assert.match(home.detail, /but os\.homedir\(\)=\/definitely-not-home/);
  assert.match(home.detail, /writes under HOME/);
});

test('doctor: token present passes, and the API check reports the budget (unit level)', async () => {
  const result = await runDoctor({ token: 'test-token', tokenSource: 'GH_TOKEN', fetchImpl: stubFetch() });
  const token = result.checks.find((check) => check.id === 'token');
  assert.equal(token.status, 'ok');
  assert.match(token.detail, /via GH_TOKEN/);
  // The token value never appears in any check detail.
  for (const check of result.checks) assert.doesNotMatch(check.detail, /test-token/);
  const api = result.checks.find((check) => check.id === 'api');
  assert.equal(api.status, 'ok');
  assert.match(api.detail, /token accepted \(4999\/5000 requests left this hour\)/);
});

test('doctor: no token warns, and the API check stays anonymous (unit level)', async () => {
  const result = await runDoctor({ token: null, fetchImpl: stubFetch() });
  const token = result.checks.find((check) => check.id === 'token');
  assert.equal(token.status, 'warn');
  assert.match(token.detail, /cannot download their logs/);
  assert.match(token.fix, /gh auth login/);
  const api = result.checks.find((check) => check.id === 'api');
  assert.equal(api.status, 'ok');
  assert.match(api.detail, /anonymous — 60 requests\/hour/);
});

test('doctor: a rejected token fails the API check (unit level)', async () => {
  const result = await runDoctor({ token: 'bad-token', tokenSource: 'GH_TOKEN', fetchImpl: stubFetch({ status: 401 }) });
  const api = result.checks.find((check) => check.id === 'api');
  assert.equal(api.status, 'fail');
  assert.match(api.detail, /rejected the token \(401\)/);
  assert.match(api.fix, /gh auth login/);
  assert.equal(result.passed, false);
});

test('doctor: an unreachable API warns, it does not fail (unit level)', async () => {
  const result = await runDoctor({
    token: null,
    fetchImpl: async () => { throw new Error('fetch failed'); },
  });
  const api = result.checks.find((check) => check.id === 'api');
  assert.equal(api.status, 'warn');
  assert.match(api.detail, /could not reach the GitHub API/);
});

test('doctor: bare temp dir — command fails, nothing is written', () => {
  const home = tempDir('ci-triage-doctor-home-');
  const binDir = tempDir('ci-triage-doctor-bin-');
  const cwd = tempDir('ci-triage-doctor-cwd-');
  const beforeHome = snapshot(home);
  const beforeCwd = snapshot(cwd);
  const result = run(['doctor'], envFor(home, binDir, cwd));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /\[FAIL\] Command — ci-triage is not on PATH/);
  assert.match(result.stdout, /Fix: Install it globally: npm install -g ci-triage-cli/);
  // On POSIX os.homedir() honours $HOME, so the sandboxed HOME
  // agrees with it and the home check passes. On Windows
  // os.homedir() reads the user profile instead, so the sandboxed
  // HOME disagrees with it and the home check warns — that warning
  // is the correct behaviour, not a failure (the unit-level test
  // above covers the disagreeing case in isolation).
  if (process.platform === 'win32') {
    assert.match(result.stdout, /\[warn\] Home — HOME=.* but os\.homedir\(\)=/);
  } else {
    assert.match(result.stdout, /\[ok\] Home — home resolves to /);
  }
  assert.match(result.stdout, /\[warn\] Skill — no SKILL\.md installed/);
  assert.match(result.stdout, /\[warn\] Token — no token found/);
  assert.match(result.stdout, /Fix: Set GH_TOKEN/);
  assert.match(result.stdout, /Doctor: 1 failing check/);
  // Read-only: doctor changes nothing.
  assert.deepEqual(snapshot(home), beforeHome);
  assert.deepEqual(snapshot(cwd), beforeCwd);
});

test('doctor: command on PATH passes, exit 0 with only warnings', () => {
  const home = tempDir('ci-triage-doctor-home-');
  const binDir = tempDir('ci-triage-doctor-bin-');
  writeFakeBinary(binDir, 'ci-triage');
  const cwd = tempDir('ci-triage-doctor-cwd-');
  const result = run(['doctor'], envFor(home, binDir, cwd));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[ok\] Command — ci-triage resolves to .*ci-triage/);
  assert.match(result.stdout, /Doctor: healthy/);
});

test('doctor: project skill passes the skill check', () => {
  const home = tempDir('ci-triage-doctor-home-');
  const binDir = tempDir('ci-triage-doctor-bin-');
  writeFakeBinary(binDir, 'ci-triage');
  const cwd = tempDir('ci-triage-doctor-cwd-');
  fs.mkdirSync(path.join(cwd, '.claude', 'skills', 'ci-triage'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'skills', 'ci-triage', 'SKILL.md'),
    '---\nname: ci-triage\ndescription: Triage red CI before reading any log.\n---\n\n# ci-triage\n');
  const result = run(['doctor'], envFor(home, binDir, cwd));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[ok\] Skill — project skill installed and valid:/);
});

test('doctor: global skill passes the skill check', () => {
  const home = tempDir('ci-triage-doctor-home-');
  const binDir = tempDir('ci-triage-doctor-bin-');
  writeFakeBinary(binDir, 'ci-triage');
  const cwd = tempDir('ci-triage-doctor-cwd-');
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'ci-triage'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'ci-triage', 'SKILL.md'),
    '---\nname: ci-triage\ndescription: Triage red CI before reading any log.\n---\n\n# ci-triage\n');
  const result = run(['doctor'], envFor(home, binDir, cwd));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[ok\] Skill — global skill installed and valid:/);
});

test('doctor: broken skill frontmatter warns and names the problem, without failing', () => {
  const home = tempDir('ci-triage-doctor-home-');
  const binDir = tempDir('ci-triage-doctor-bin-');
  writeFakeBinary(binDir, 'ci-triage');
  const cwd = tempDir('ci-triage-doctor-cwd-');
  fs.mkdirSync(path.join(cwd, '.claude', 'skills', 'ci-triage'), { recursive: true });
  // Name is uppercase and does not match the directory; description
  // contains angle brackets — both make the skill silently never
  // trigger, and doctor used to report it as installed and fine.
  fs.writeFileSync(path.join(cwd, '.claude', 'skills', 'ci-triage', 'SKILL.md'),
    '---\nname: Ci-Triage\ndescription: Triage red CI <broken>.\n---\n\n# ci-triage\n');
  const result = run(['doctor'], envFor(home, binDir, cwd));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[warn\] Skill — project skill is invalid: name "Ci-Triage" must be lowercase/);
  assert.match(result.stdout, /Fix: Fix the SKILL\.md frontmatter/);
});

test('doctor: --json is machine-readable', () => {
  const home = tempDir('ci-triage-doctor-home-');
  const binDir = tempDir('ci-triage-doctor-bin-');
  const cwd = tempDir('ci-triage-doctor-cwd-');
  const result = run(['doctor', '--json'], envFor(home, binDir, cwd));
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.version, VERSION);
  assert.equal(parsed.checks.length, 6);
  assert.deepEqual(parsed.checks.map((check) => check.id), ['node', 'command', 'home', 'skill', 'token', 'api']);
  assert.equal(parsed.passed, false);
  assert.equal(parsed.failed, 1);
  // Warnings are at least skill + token; the API row warns too when
  // the network is down, so only a floor is asserted.
  assert.ok(parsed.warnings >= 2);
  for (const check of parsed.checks) {
    assert.ok(['ok', 'warn', 'fail'].includes(check.status));
    assert.equal(typeof check.detail, 'string');
  }
});

test('doctor: inside the source repo the fix names the local bin', () => {
  const home = tempDir('ci-triage-doctor-home-');
  const binDir = tempDir('ci-triage-doctor-bin-');
  const cwd = tempDir('ci-triage-doctor-cwd-');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'ci-triage-cli', version: '0.0.0' }));
  const result = run(['doctor'], envFor(home, binDir, cwd));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /\[FAIL\] Command — ci-triage is not on PATH/);
  assert.match(result.stdout, /Fix: You are inside the ci-triage source repo: run node bin\/ci-triage\.js here/);
});

test('doctor: HOME agreeing with os.homedir() passes the home check', () => {
  const binDir = tempDir('ci-triage-doctor-bin-');
  const cwd = tempDir('ci-triage-doctor-cwd-');
  // No HOME in the child env: resolveHome() falls back to
  // os.homedir(), so there is nothing to disagree with. The child
  // only reads the real home (skill) — doctor writes nothing, so
  // that is safe.
  const env = { ...process.env, PATH: binDir };
  delete env.HOME;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const result = run(['doctor'], { env, cwd });
  assert.match(result.stdout, /\[ok\] Home — home resolves to /);
});

test('doctor: rejects other options', () => {
  const result = run(['doctor', '--runs', '5']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /doctor takes no options except --json/);
  const extra = run(['doctor', 'extra']);
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /doctor takes no options except --json/);
  const mcp = run(['doctor', '--mcp']);
  assert.equal(mcp.status, 2);
  assert.match(mcp.stderr, /--mcp takes no other arguments/);
});

test('doctor: --help lists doctor', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /ci-triage doctor \[--json\]/);
});
