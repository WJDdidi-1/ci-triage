import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { job, run, startMockServer } from './mock-server.mjs';
import { starPromptLine } from '../lib/report.mjs';
import { tempDir } from '../scripts/support.mjs';

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

test('cli: starPromptLine only fires on a TTY', () => {
  assert.equal(starPromptLine(true), 'If this saved you time, star ci-triage: https://github.com/WJDdidi-1/ci-triage');
  assert.equal(starPromptLine(false), null);
  assert.equal(starPromptLine(undefined), null);
});

test('cli: piped triage output never carries the star prompt', async () => {
  const scenario = {
    runs: [run(1, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'build' })] },
    logs: { 11: read('tsc-error.log') },
  };
  const mock = await startMockServer(scenario);
  try {
    const result = await runCli(['o/r'], { env: { ...process.env, CI_TRIAGE_API_BASE: mock.base } });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /star ci-triage/);
  } finally {
    await mock.close();
  }
});

test('cli: --json output never carries the star prompt', async () => {
  const scenario = {
    runs: [run(1, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'build' })] },
    logs: { 11: read('tsc-error.log') },
  };
  const mock = await startMockServer(scenario);
  try {
    const result = await runCli(['o/r', '--json'], { env: { ...process.env, CI_TRIAGE_API_BASE: mock.base } });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /star ci-triage/);
    JSON.parse(result.stdout); // still valid JSON with no prompt in it
  } finally {
    await mock.close();
  }
});

// Async spawn of `script`, so the mock server in this process can still
// answer while the child runs on a pty. Flags differ per platform like
// the dev-diagnosis TTY test; Windows has no `script` at all.
function runCliOnTty(args, options = {}) {
  return new Promise((resolve, reject) => {
    const argv = process.platform === 'darwin'
      ? ['-q', '-e', '/dev/null', process.execPath, bin, ...args]
      : ['-qec', [process.execPath, bin, ...args].map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' '), '/dev/null'];
    const child = spawn('script', argv, { ...options });
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
      reject(new Error(`ci-triage ${args.join(' ')} on a pty timed out`));
    }, 20000).unref();
  });
}

test('cli: triage on a TTY prints the star prompt after the verdict', { skip: process.platform === 'win32' }, async (t) => {
  if (spawnSync('which', ['script']).status !== 0) t.skip('no script binary for a pty');
  const scenario = {
    runs: [run(1, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'build' })] },
    logs: { 11: read('tsc-error.log') },
  };
  const mock = await startMockServer(scenario);
  try {
    const result = await runCliOnTty(['o/r'], { env: { ...process.env, CI_TRIAGE_API_BASE: mock.base } });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /If this saved you time, star ci-triage: https:\/\/github\.com\/WJDdidi-1\/ci-triage/);
  } finally {
    await mock.close();
  }
});

test('cli: --help lists the triage options', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.status, 0);
  for (const word of ['<owner/repo>', '--runs', '--workflow', '--branch', '--json', '--top', '--report', '--annotations', '--mcp', '--skill-generate']) {
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

test('cli: a mistyped option suggests the intended option', async () => {
  const result = await runCli(['o/r', '--hepl']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option: --hepl/);
  assert.match(result.stderr, /Did you mean '--help'\?/);
  const json = await runCli(['o/r', '--jso']);
  assert.equal(json.status, 2);
  assert.match(json.stderr, /Did you mean '--json'\?/);
});

test('cli: a far-off option typo gets no suggestion', async () => {
  const result = await runCli(['o/r', '--frobnicate']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option/);
  assert.doesNotMatch(result.stderr, /Did you mean/);
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

test('cli: GITHUB_STEP_SUMMARY gets the Markdown report, and a second run appends', async () => {
  const scenario = {
    runs: [run(1, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'build' })] },
    logs: { 11: read('tsc-error.log') },
  };
  const mock = await startMockServer(scenario);
  try {
    const dir = tempDir('ci-triage-summary-cli-');
    const file = path.join(dir, 'summary.md');
    const env = { ...process.env, CI_TRIAGE_API_BASE: mock.base, GITHUB_STEP_SUMMARY: file };
    const first = await runCli(['o/r'], { env, cwd: dir });
    assert.equal(first.status, 1);
    let content = fs.readFileSync(file, 'utf8');
    assert.match(content, /^## ci-triage — o\/r$/m);
    assert.match(content, /^### #1 build · 1 run · real regression$/m);
    assert.match(content, /TS2322/);
    const second = await runCli(['o/r'], { env, cwd: dir });
    assert.equal(second.status, 1);
    content = fs.readFileSync(file, 'utf8');
    assert.equal(content.match(/^## ci-triage — o\/r$/gm).length, 2);
  } finally {
    await mock.close();
  }
});

test('cli: without GITHUB_STEP_SUMMARY no summary file is created', async () => {
  const scenario = {
    runs: [run(1, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'build' })] },
    logs: { 11: read('tsc-error.log') },
  };
  const mock = await startMockServer(scenario);
  try {
    const dir = tempDir('ci-triage-summary-none-');
    const file = path.join(dir, 'summary.md');
    const env = { ...process.env, CI_TRIAGE_API_BASE: mock.base };
    delete env.GITHUB_STEP_SUMMARY;
    const result = await runCli(['o/r'], { env, cwd: dir });
    assert.equal(result.status, 1);
    assert.ok(!fs.existsSync(file));
  } finally {
    await mock.close();
  }
});

test('cli: GITHUB_STEP_SUMMARY appends to existing content, never replaces it', async () => {
  const scenario = {
    runs: [run(1, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'build' })] },
    logs: { 11: read('tsc-error.log') },
  };
  const mock = await startMockServer(scenario);
  try {
    const dir = tempDir('ci-triage-summary-keep-');
    const file = path.join(dir, 'summary.md');
    fs.writeFileSync(file, '# Earlier step\n');
    const env = { ...process.env, CI_TRIAGE_API_BASE: mock.base, GITHUB_STEP_SUMMARY: file };
    const result = await runCli(['o/r'], { env, cwd: dir });
    assert.equal(result.status, 1);
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.startsWith('# Earlier step\n'));
    assert.match(content, /## ci-triage — o\/r/);
  } finally {
    await mock.close();
  }
});

test('cli: --report writes the Markdown triage to a file', async () => {
  const scenario = {
    runs: [run(1, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'build' })] },
    logs: { 11: read('tsc-error.log') },
  };
  const mock = await startMockServer(scenario);
  try {
    const dir = tempDir('ci-triage-report-cli-');
    const file = path.join(dir, 'triage.md');
    const result = await runCli(['o/r', '--report', file], { env: { ...process.env, CI_TRIAGE_API_BASE: mock.base }, cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Wrote report to /);
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /^## ci-triage — o\/r$/m);
    assert.match(content, /^### #1 build · 1 run · real regression$/m);
    assert.match(content, /TS2322/);
    assert.match(content, /Fetched: /);
  } finally {
    await mock.close();
  }
});

test('cli: --json --report keeps stdout parseable and confirms on stderr', async () => {
  const scenario = {
    runs: [run(1, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'build' })] },
    logs: { 11: read('tsc-error.log') },
  };
  const mock = await startMockServer(scenario);
  try {
    const dir = tempDir('ci-triage-report-json-');
    const file = path.join(dir, 'triage.md');
    const result = await runCli(['o/r', '--json', '--report', file], { env: { ...process.env, CI_TRIAGE_API_BASE: mock.base }, cwd: dir });
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout); // still valid JSON
    assert.equal(parsed.clusters.length, 1);
    assert.doesNotMatch(result.stdout, /Wrote report to/);
    assert.match(result.stderr, /Wrote report to /);
    assert.match(fs.readFileSync(file, 'utf8'), /^## ci-triage — o\/r$/m);
  } finally {
    await mock.close();
  }
});

test('cli: --report needs a value, and does not combine with --mcp', async () => {
  assert.equal((await runCli(['o/r', '--report'])).status, 2);
  assert.match((await runCli(['o/r', '--report'])).stderr, /--report needs a value/);
  assert.match((await runCli(['o/r', '--report', 'x.md', '--mcp'])).stderr, /--mcp takes no other arguments/);
  assert.match((await runCli(['o/r', '--report=x.md', '--mcp'])).stderr, /--mcp takes no other arguments/);
});

test('cli: --report to an unwritable path exits 1 with a clear error', async () => {
  const scenario = {
    runs: [run(1, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'build' })] },
    logs: { 11: read('tsc-error.log') },
  };
  const mock = await startMockServer(scenario);
  try {
    const dir = tempDir('ci-triage-report-unwritable-');
    const file = path.join(dir, 'missing-dir', 'triage.md');
    const result = await runCli(['o/r', '--report', file], { env: { ...process.env, CI_TRIAGE_API_BASE: mock.base }, cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not write report to/);
  } finally {
    await mock.close();
  }
});

test('cli: --json still writes the summary file and stays valid JSON', async () => {
  const scenario = {
    runs: [run(1, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'build' })] },
    logs: { 11: read('tsc-error.log') },
  };
  const mock = await startMockServer(scenario);
  try {
    const dir = tempDir('ci-triage-summary-json-');
    const file = path.join(dir, 'summary.md');
    const env = { ...process.env, CI_TRIAGE_API_BASE: mock.base, GITHUB_STEP_SUMMARY: file };
    const result = await runCli(['o/r', '--json'], { env, cwd: dir });
    assert.equal(result.status, 1);
    JSON.parse(result.stdout); // still valid JSON
    assert.match(fs.readFileSync(file, 'utf8'), /^## ci-triage — o\/r$/m);
  } finally {
    await mock.close();
  }
});

test('cli: --annotations emits a workflow command per root cause', async () => {
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
    const result = await runCli(['o/r', '--annotations'], { env: { ...process.env, CI_TRIAGE_API_BASE: mock.base } });
    assert.equal(result.status, 1);
    // The cluster pins to the newest run's location: run #2's stack
    // frame is at Button.test.tsx:57 (run #1's is at :42).
    assert.match(result.stdout, /^::error file=src\/components\/Button\.test\.tsx,line=57,title=ci-triage o\/r — #1 test · 2 runs · real regression::/m);
    assert.match(result.stdout, /FAIL src\/components\/Button\.test\.tsx/);
    assert.match(result.stdout, /Overall: 1 root cause/);
  } finally {
    await mock.close();
  }
});

test('cli: --json --annotations keeps stdout parseable and puts annotations on stderr', async () => {
  const scenario = {
    runs: [run(1, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'build' })] },
    logs: { 11: read('tsc-error.log') },
  };
  const mock = await startMockServer(scenario);
  try {
    const result = await runCli(['o/r', '--json', '--annotations'], { env: { ...process.env, CI_TRIAGE_API_BASE: mock.base } });
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout); // still valid JSON
    assert.equal(parsed.clusters.length, 1);
    assert.doesNotMatch(result.stdout, /::error /);
    assert.match(result.stderr, /^::error file=src\/utils\/format\.ts,line=18,title=ci-triage o\/r/m);
  } finally {
    await mock.close();
  }
});

test('cli: --annotations on a clean window emits no annotation lines', async () => {
  const mock = await startMockServer({ runs: [run(1, { conclusion: 'success' })], jobs: {}, logs: {} });
  try {
    const result = await runCli(['o/r', '--annotations'], { env: { ...process.env, CI_TRIAGE_API_BASE: mock.base } });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /::(error|warning) /);
  } finally {
    await mock.close();
  }
});

test('cli: --annotations does not combine with --mcp or --skill-generate', async () => {
  assert.match((await runCli(['o/r', '--annotations', '--mcp'])).stderr, /--mcp takes no other arguments/);
  assert.match((await runCli(['o/r', '--annotations', '--skill-generate'])).stderr, /--skill-generate takes no other arguments/);
  assert.match((await runCli(['doctor', '--annotations'])).stderr, /doctor takes no options except --json/);
});
