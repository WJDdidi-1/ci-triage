import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { job, run, startMockServer } from './mock-server.mjs';
import { SKILL_MD } from '../lib/skill.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'ci-triage.js');
const fixtures = path.join(root, 'test', 'fixtures');
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

// The two scenarios behind the Examples section: the same fixture
// logs triage.test.mjs uses — a Jest failure that passes in between
// (flaky) and a TypeScript error that fails on every run (real
// regression).
const flakyScenario = {
  runs: [
    run(3, { conclusion: 'failure', headSha: 'bbb0000000000000000000000000000000000000', createdAt: '2026-11-12T14:03:15Z' }),
    run(2, { conclusion: 'success', headSha: 'ccc0000000000000000000000000000000000000', createdAt: '2026-11-12T12:00:00Z' }),
    run(1, { conclusion: 'failure', headSha: 'aaa0000000000000000000000000000000000000', createdAt: '2026-11-12T10:00:00Z' }),
  ],
  jobs: {
    3: [job(31, { name: 'test' })],
    1: [job(11, { name: 'test' })],
  },
  logs: {
    31: read('jest-failure-run2.log'),
    11: read('jest-failure.log'),
  },
};

const regressionScenario = {
  runs: [
    run(2, { conclusion: 'failure', headSha: 'bbb0000000000000000000000000000000000000', createdAt: '2026-11-12T14:03:15Z' }),
    run(1, { conclusion: 'failure', headSha: 'aaa0000000000000000000000000000000000000', createdAt: '2026-11-12T10:00:00Z' }),
  ],
  jobs: {
    2: [job(21, { name: 'build' })],
    1: [job(11, { name: 'build' })],
  },
  logs: {
    21: read('tsc-error.log'),
    11: read('tsc-error.log'),
  },
};

// The lines the Examples section in SKILL.md quotes. If the CLI's
// output format changes, these tests fail until the skill is updated
// — the examples must stay real output, not remembered output. The
// method is dev-diagnosis's demo tape --check: pin the shown lines
// to live runs.
const EXAMPLE_1_LINES = [
  'Window: 3 recent runs listed, 2 failed examined',
  'Root causes: 1 (0 real, 1 flaky)',
  '#1  test · 2 runs · FLAKY',
  'FAIL src/components/Button.test.tsx',
  'Overall: 1 root cause — 0 real regressions, 1 flaky',
];
const EXAMPLE_2_LINES = [
  'Window: 2 recent runs listed, 2 failed examined',
  'Root causes: 1 (1 real, 0 flaky)',
  '#1  build · 2 runs · real regression',
  "src/utils/format.ts:18:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
  'Overall: 1 root cause — 1 real regression, 0 flaky',
];

test('skill-examples: SKILL.md has an Examples section quoting the real output', () => {
  assert.match(SKILL_MD, /^## Examples$/m);
  for (const line of [...EXAMPLE_1_LINES, ...EXAMPLE_2_LINES]) {
    assert.ok(SKILL_MD.includes(line), `SKILL.md quotes "${line}"`);
  }
  // The Rules carry their why, not bare commands (skill-creator:
  // explain why, never a bare ALWAYS/NEVER).
  assert.match(SKILL_MD, /fixing the top cause clears the most runs/);
});

test('skill-examples: example 1 — the flaky scenario produces the quoted lines', async () => {
  const mock = await startMockServer(flakyScenario);
  try {
    const result = await runCli(['o/r'], { env: { ...process.env, CI_TRIAGE_API_BASE: mock.base } });
    for (const line of EXAMPLE_1_LINES) {
      assert.ok(result.stdout.includes(line), `live output is missing: ${line}`);
    }
  } finally {
    await mock.close();
  }
});

test('skill-examples: example 2 — the real-regression scenario produces the quoted lines', async () => {
  const mock = await startMockServer(regressionScenario);
  try {
    const result = await runCli(['o/r'], { env: { ...process.env, CI_TRIAGE_API_BASE: mock.base } });
    for (const line of EXAMPLE_2_LINES) {
      assert.ok(result.stdout.includes(line), `live output is missing: ${line}`);
    }
  } finally {
    await mock.close();
  }
});
