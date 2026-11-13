import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { job, run, startMockServer } from './mock-server.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const bin = path.join(root, 'bin', 'ci-triage.js');
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => readFileSync(path.join(fixtures, name), 'utf8');

// Async spawn (not spawnSync): the mock server lives in this
// process's event loop, so a synchronous wait would deadlock — the
// child waits for the server while the server waits for the parent.
function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ci-triage ${args.join(' ')} timed out`));
    }, 20000).unref();
  });
}

test('cli: --help lists the triage options', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.status, 0);
  for (const word of ['<owner/repo>', '--runs', '--workflow', '--branch', '--json', '--top', '--mcp', '--skill-generate']) {
    assert.ok(result.stdout.includes(word), `help should mention ${word}`);
  }
});

test('cli: --version prints the package version', async () => {
  const result = await runCli(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkgVersion);
});

test('cli: no repo is a usage error', async () => {
  const result = await runCli([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /repository is required/);
});

test('cli: a malformed repo is a usage error', async () => {
  const result = await runCli(['not-a-repo']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot parse repository/);
});

test('cli: an unknown option is a usage error', async () => {
  const result = await runCli(['o/r', '--frobnicate']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option/);
});

test('cli: --runs out of range is a usage error', async () => {
  assert.equal((await runCli(['o/r', '--runs', '0'])).status, 2);
  assert.equal((await runCli(['o/r', '--runs', '31'])).status, 2);
});

test('cli: --mcp with a repo is a usage error', async () => {
  const result = await runCli(['o/r', '--mcp']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--mcp takes no other arguments/);
});

test('cli: triage against the mock server exits 1 with a ranked report', async () => {
  const scenario = {
    runs: [
      run(2, { conclusion: 'failure', headSha: 'bbb0000000000000000000000000000000000000', createdAt: '2026-11-12T14:03:15Z' }),
      run(1, { conclusion: 'failure', headSha: 'aaa0000000000000000000000000000000000000', createdAt: '2026-11-12T10:00:00Z' }),
    ],
    jobs: { 2: [job(21, { name: 'test' })], 1: [job(11, { name: 'test' })] },
    logs: { 21: read('jest-failure-run2.log'), 11: read('jest-failure.log') },
  };
  const mock = await startMockServer(scenario);
  try {
    const result = await runCli(['o/r', '--runs', '10'], { env: { ...process.env, CI_TRIAGE_API_BASE: mock.base } });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ci-triage — o\/r/);
    assert.match(result.stdout, /Root causes: 1/);
    assert.match(result.stdout, /test · 2 runs · real regression/);
    assert.match(result.stdout, /FAIL src\/components\/Button\.test\.tsx/);
    assert.match(result.stdout, /Overall: 1 root cause — 1 real regression, 0 flaky/);
  } finally {
    await mock.close();
  }
});

test('cli: --json output parses and carries the clusters', async () => {
  const scenario = {
    runs: [run(1, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'build' })] },
    logs: { 11: read('tsc-error.log') },
  };
  const mock = await startMockServer(scenario);
  try {
    const result = await runCli(['o/r', '--json'], { env: { ...process.env, CI_TRIAGE_API_BASE: mock.base } });
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.repo, 'o/r');
    assert.equal(parsed.clusters.length, 1);
    assert.equal(parsed.clusters[0].category, 'build');
    assert.match(parsed.clusters[0].headline, /TS2322/);
  } finally {
    await mock.close();
  }
});

test('cli: a clean window exits 0', async () => {
  const mock = await startMockServer({ runs: [run(1, { conclusion: 'success' })], jobs: {}, logs: {} });
  try {
    const result = await runCli(['o/r'], { env: { ...process.env, CI_TRIAGE_API_BASE: mock.base } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No failures found/);
    assert.match(result.stdout, /Overall: CLEAN/);
  } finally {
    await mock.close();
  }
});

test('cli: an unreachable API is exit 2, not a fake clean', async () => {
  const result = await runCli(['o/r'], { env: { ...process.env, CI_TRIAGE_API_BASE: 'http://127.0.0.1:1' } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not reach the GitHub API/);
});

test('cli: failed jobs with unreadable logs exit 1 and say UNKNOWN, not CLEAN', async () => {
  const mock = await startMockServer({
    runs: [run(1, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'test' })] },
    logs: { 11: 403 },
  });
  try {
    const result = await runCli(['o/r'], { env: { ...process.env, CI_TRIAGE_API_BASE: mock.base } });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /UNKNOWN/);
    assert.match(result.stdout, /needs a GitHub token/);
    assert.doesNotMatch(result.stdout, /CLEAN/);
  } finally {
    await mock.close();
  }
});
