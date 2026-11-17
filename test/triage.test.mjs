import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { job, run, startMockServer } from './mock-server.mjs';
import { tempDir } from '../scripts/support.mjs';
import { loadKnownFailures, writeKnownFailures } from '../lib/known.mjs';
import { triageLogText, triageRepo } from '../lib/triage.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => readFileSync(path.join(fixtures, name), 'utf8');

// Two failed runs with the same jest signature, with a successful
// run of the same workflow on the same branch in between: one
// cluster, flaky, count 2.
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

test('triage: same signature across runs clusters into one flaky cluster', async () => {
  const mock = await startMockServer(flakyScenario);
  try {
    process.env.CI_TRIAGE_API_BASE = mock.base;
    const result = await triageRepo('o/r', { runs: 10 });
    assert.equal(result.window.failedRuns, 2);
    assert.equal(result.clusters.length, 1);
    const [cluster] = result.clusters;
    assert.equal(cluster.count, 2);
    assert.equal(cluster.category, 'test');
    assert.equal(cluster.flaky, true);
    assert.match(cluster.flakyReason, /intermittently/);
    assert.deepEqual(cluster.runs.map((r) => r.number), [3, 1]);
  } finally {
    delete process.env.CI_TRIAGE_API_BASE;
    await mock.close();
  }
});

test('triage: progress lines show the real run number, never #undefined', async () => {
  // Live dogfood (2026-11-14) found the progress lines printing
  // "run #undefined": the mapper read run.number, but the real API
  // field is run_number. The mock used to return `number` too, which
  // hid the bug; it now returns run_number like the real API.
  const mock = await startMockServer(flakyScenario);
  try {
    process.env.CI_TRIAGE_API_BASE = mock.base;
    const lines = [];
    await triageRepo('o/r', { runs: 10, onProgress: (line) => lines.push(line) });
    assert.ok(lines.some((line) => line.includes('run #3:')));
    assert.ok(lines.some((line) => line.includes('run #1:')));
    assert.ok(!lines.some((line) => line.includes('#undefined')));
  } finally {
    delete process.env.CI_TRIAGE_API_BASE;
    await mock.close();
  }
});

test('triage: different signatures are different clusters, ranked by count', async () => {
  const scenario = {
    runs: [
      run(3, { conclusion: 'failure', headSha: 'bbb0000000000000000000000000000000000000', createdAt: '2026-11-12T14:03:15Z' }),
      run(2, { conclusion: 'failure', headSha: 'ccc0000000000000000000000000000000000000', createdAt: '2026-11-12T12:00:00Z' }),
      run(1, { conclusion: 'failure', headSha: 'aaa0000000000000000000000000000000000000', createdAt: '2026-11-12T10:00:00Z' }),
    ],
    jobs: {
      3: [job(31, { name: 'test' })],
      2: [job(21, { name: 'build' })],
      1: [job(11, { name: 'test' })],
    },
    logs: {
      31: read('jest-failure-run2.log'),
      21: read('tsc-error.log'),
      11: read('jest-failure.log'),
    },
  };
  const mock = await startMockServer(scenario);
  try {
    process.env.CI_TRIAGE_API_BASE = mock.base;
    const result = await triageRepo('o/r', { runs: 10 });
    assert.equal(result.clusters.length, 2);
    assert.equal(result.clusters[0].count, 2);
    assert.equal(result.clusters[0].category, 'test');
    assert.equal(result.clusters[1].count, 1);
    assert.equal(result.clusters[1].category, 'build');
    // No successes in the window: the repeated jest failure is a
    // real regression, not flaky.
    assert.equal(result.clusters[0].flaky, false);
  } finally {
    delete process.env.CI_TRIAGE_API_BASE;
    await mock.close();
  }
});

test('triage: no failed runs is a clean result', async () => {
  const mock = await startMockServer({ runs: [run(1, { conclusion: 'success' })], jobs: {}, logs: {} });
  try {
    process.env.CI_TRIAGE_API_BASE = mock.base;
    const result = await triageRepo('o/r', { runs: 10 });
    assert.equal(result.window.failedRuns, 0);
    assert.deepEqual(result.clusters, []);
    assert.deepEqual(result.failures, []);
  } finally {
    delete process.env.CI_TRIAGE_API_BASE;
    await mock.close();
  }
});

test('triage: a failed job with an expired log is recorded, not fatal', async () => {
  const mock = await startMockServer({
    runs: [run(1, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'test' })] },
    logs: {},
  });
  try {
    process.env.CI_TRIAGE_API_BASE = mock.base;
    const result = await triageRepo('o/r', { runs: 10 });
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].logError, /no longer available/);
    assert.equal(result.clusters.length, 0);
  } finally {
    delete process.env.CI_TRIAGE_API_BASE;
    await mock.close();
  }
});

test('triage: a 403 on a log says plainly that a token is needed', async () => {
  const mock = await startMockServer({
    runs: [run(1, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'test' })] },
    logs: { 11: 403 },
  });
  try {
    process.env.CI_TRIAGE_API_BASE = mock.base;
    const result = await triageRepo('o/r', { runs: 10 });
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].logError, /needs a GitHub token/);
    assert.equal(result.clusters.length, 0);
  } finally {
    delete process.env.CI_TRIAGE_API_BASE;
    await mock.close();
  }
});

test('triage: one refused log download stops the rest — no doomed retries', async () => {
  // Dogfood finding: unauthenticated against WJDdidi-1/dev-doctor,
  // the triage made 30 log downloads, every one a 403, before
  // reporting the token message once — 21.7 s and half the 60/hour
  // anonymous budget on requests known to fail after the first.
  const mock = await startMockServer({
    runs: [run(1, { conclusion: 'failure' }), run(2, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'a' }), job(12, { name: 'b' })], 2: [job(21, { name: 'c' }), job(22, { name: 'd' })] },
    logs: { 11: 403, 12: 403, 21: 403, 22: 403 },
  });
  try {
    process.env.CI_TRIAGE_API_BASE = mock.base;
    const result = await triageRepo('o/r', { runs: 10 });
    // All four failed jobs are still reported, with the same reason —
    // the jobs lists succeeded, only the downloads were refused.
    assert.equal(result.failures.length, 4);
    assert.ok(result.failures.every((f) => /needs a GitHub token/.test(f.logError)));
    assert.equal(result.clusters.length, 0);
    // But only one download was attempted.
    assert.equal(mock.requests.filter((p) => p.endsWith('/logs')).length, 1);
  } finally {
    delete process.env.CI_TRIAGE_API_BASE;
    await mock.close();
  }
});

test('triage: a transient log failure does not stop the other downloads', async () => {
  // Only the 403 is terminal: a 500 on one job must not poison the
  // downloads after it.
  const mock = await startMockServer({
    runs: [run(1, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'a' }), job(12, { name: 'b' })] },
    logs: { 11: 500, 12: 'Error: test suite failed\n  at foo.test.js:42' },
  });
  try {
    process.env.CI_TRIAGE_API_BASE = mock.base;
    const result = await triageRepo('o/r', { runs: 10 });
    assert.equal(result.failures.length, 2);
    assert.match(result.failures[0].logError, /500/);
    assert.ok(result.failures[1].signature, 'expected the second job to be triaged');
    assert.equal(mock.requests.filter((p) => p.endsWith('/logs')).length, 2);
  } finally {
    delete process.env.CI_TRIAGE_API_BASE;
    await mock.close();
  }
});

test('triage: jobs lists are fetched before any log download starts', async () => {
  // The jobs lists used to be fetched one run at a time, each
  // followed by that run's log downloads — ten failed runs cost
  // ~10 s of sequential list calls before the log work. The lists
  // are independent GETs, so they now go out concurrently and the
  // downloads run afterwards, in run order. The mock records
  // request order, which proves the two phases are separated
  // without depending on timing.
  const mock = await startMockServer({
    runs: [run(1, { conclusion: 'failure' }), run(2, { conclusion: 'failure' })],
    jobs: { 1: [job(11, { name: 'a' })], 2: [job(21, { name: 'b' })] },
    logs: { 11: 'Error: test suite failed\n  at foo.test.js:42', 21: 'Error: test suite failed\n  at foo.test.js:42' },
  });
  try {
    process.env.CI_TRIAGE_API_BASE = mock.base;
    const result = await triageRepo('o/r', { runs: 10 });
    // The report is unchanged: both failures, in run order, triaged.
    assert.equal(result.failures.length, 2);
    assert.deepEqual(result.failures.map((f) => f.run), [1, 2]);
    // The run's date rides the public failure shape: the UNKNOWN
    // report's span line reads it, and it was once dropped at this
    // boundary — the line silently vanished on a real triage.
    assert.deepEqual(result.failures.map((f) => f.createdAt), ['2026-11-12T14:03:15Z', '2026-11-12T14:03:15Z']);
    assert.ok(result.failures.every((f) => f.signature), 'expected both jobs to be triaged');
    // Every jobs-list request precedes every log download.
    const jobsIdx = mock.requests.map((p, i) => (p.endsWith('/jobs') ? i : -1)).filter((i) => i >= 0);
    const logsIdx = mock.requests.map((p, i) => (p.endsWith('/logs') ? i : -1)).filter((i) => i >= 0);
    assert.equal(jobsIdx.length, 2);
    assert.equal(logsIdx.length, 2);
    assert.ok(Math.max(...jobsIdx) < Math.min(...logsIdx), 'expected all jobs lists before any log download');
  } finally {
    delete process.env.CI_TRIAGE_API_BASE;
    await mock.close();
  }
});

test('triage: --runs limits how many failed runs are examined', async () => {
  const scenario = {
    runs: [
      run(3, { conclusion: 'failure' }),
      run(2, { conclusion: 'failure' }),
      run(1, { conclusion: 'failure' }),
    ],
    jobs: { 3: [job(31)], 2: [job(21)], 1: [job(11)] },
    logs: { 31: read('jest-failure.log'), 21: read('tsc-error.log'), 11: read('timeout.log') },
  };
  const mock = await startMockServer(scenario);
  try {
    process.env.CI_TRIAGE_API_BASE = mock.base;
    const result = await triageRepo('o/r', { runs: 1 });
    assert.equal(result.window.failedRuns, 1);
    assert.equal(result.clusters.length, 1);
  } finally {
    delete process.env.CI_TRIAGE_API_BASE;
    await mock.close();
  }
});

test('triageLogText: a pasted log classifies without the network', () => {
  const out = triageLogText(read('jest-failure.log'), { label: 'test' });
  assert.equal(out.category, 'test');
  assert.ok(out.signature.id);
  assert.equal(out.flaky, false);
  assert.match(out.flakyReason, /needs run history/);
  assert.equal(triageLogText('').signature, null);
});

test('triage: a recorded cluster comes back marked known, not a new regression', async () => {
  const scenario = {
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
  const mock = await startMockServer(scenario);
  const dir = await tempDir('ci-triage-known-');
  try {
    process.env.CI_TRIAGE_API_BASE = mock.base;
    const first = await triageRepo('o/r', { runs: 10 });
    assert.equal(first.clusters.length, 1);
    assert.equal(first.clusters[0].known, false);
    assert.equal(first.knownFailures, null);
    // Record it, then triage the same window again: the same
    // signature is now a known failure, and nothing is "not seen".
    const file = path.join(dir, '.ci-triage-known-failures.json');
    const recorded = writeKnownFailures(file, first.clusters, { workflow: first.workflow });
    assert.equal(recorded.added, 1);
    const second = await triageRepo('o/r', {
      runs: 10, known: loadKnownFailures(file), knownPath: file,
    });
    assert.equal(second.clusters.length, 1);
    assert.equal(second.clusters[0].known, true);
    assert.equal(second.knownFailures.entries, 1);
    assert.deepEqual(second.knownFailures.notSeen, []);
  } finally {
    delete process.env.CI_TRIAGE_API_BASE;
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('triage: a recorded signature that stops appearing is listed as not seen', async () => {
  const mock = await startMockServer({
    runs: [run(1, { conclusion: 'success' })], jobs: {}, logs: {},
  });
  const dir = await tempDir('ci-triage-known-');
  try {
    process.env.CI_TRIAGE_API_BASE = mock.base;
    const file = path.join(dir, '.ci-triage-known-failures.json');
    writeKnownFailures(file, [{
      id: '0123456789ab', headline: 'FAIL old test', category: 'test',
      flaky: false, firstSeen: '2026-11-12T10:00:00Z',
    }]);
    const result = await triageRepo('o/r', {
      runs: 10, known: loadKnownFailures(file), knownPath: file,
    });
    assert.equal(result.clusters.length, 0);
    assert.equal(result.knownFailures.entries, 1);
    assert.equal(result.knownFailures.notSeen.length, 1);
    assert.equal(result.knownFailures.notSeen[0].signature, '0123456789ab');
  } finally {
    delete process.env.CI_TRIAGE_API_BASE;
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('triage: a real regression carries its green-to-red window', async () => {
  // Run #1 green, runs #2 and #3 red with the same signature and no
  // success in between: one real regression, and the window names
  // the last green run and the first red one.
  const scenario = {
    runs: [
      run(3, { conclusion: 'failure', headSha: 'bbb0000000000000000000000000000000000000', createdAt: '2026-11-12T14:03:15Z' }),
      run(2, { conclusion: 'failure', headSha: 'aaa0000000000000000000000000000000000000', createdAt: '2026-11-12T10:00:00Z' }),
      run(1, { conclusion: 'success', headSha: 'ccc0000000000000000000000000000000000000', createdAt: '2026-11-12T08:00:00Z' }),
    ],
    jobs: {
      3: [job(31, { name: 'test' })],
      2: [job(21, { name: 'test' })],
    },
    logs: {
      31: read('jest-failure-run2.log'),
      21: read('jest-failure.log'),
    },
  };
  const mock = await startMockServer(scenario);
  try {
    process.env.CI_TRIAGE_API_BASE = mock.base;
    const result = await triageRepo('o/r', { runs: 10 });
    assert.equal(result.clusters.length, 1);
    const [cluster] = result.clusters;
    assert.equal(cluster.flaky, false);
    assert.equal(cluster.regressionWindow.lastGreen.number, 1);
    assert.equal(cluster.regressionWindow.lastGreen.headSha, 'ccc0000000000000000000000000000000000000');
    assert.equal(cluster.regressionWindow.firstRed.number, 2);
    assert.equal(cluster.regressionWindow.firstRed.headSha, 'aaa0000000000000000000000000000000000000');
  } finally {
    delete process.env.CI_TRIAGE_API_BASE;
    await mock.close();
  }
});

test('triage: a real regression names the files changed between green and red', async () => {
  // Same green→red window as the test above, plus a compare that
  // names 12 changed files: the report carries the first 10 and
  // the count of the rest, with the compare URL to open the full
  // diff.
  const changed = ['lib/context.mjs', 'test/context.test.mjs', 'README.md', 'CHANGELOG.md', 'package.json',
    'package-lock.json', 'lib/a.mjs', 'lib/b.mjs', 'lib/c.mjs', 'lib/d.mjs', 'lib/e.mjs', 'lib/f.mjs'];
  const scenario = {
    runs: [
      run(3, { conclusion: 'failure', headSha: 'bbb0000000000000000000000000000000000000', createdAt: '2026-11-12T14:03:15Z' }),
      run(2, { conclusion: 'failure', headSha: 'aaa0000000000000000000000000000000000000', createdAt: '2026-11-12T10:00:00Z' }),
      run(1, { conclusion: 'success', headSha: 'ccc0000000000000000000000000000000000000', createdAt: '2026-11-12T08:00:00Z' }),
    ],
    jobs: {
      3: [job(31, { name: 'test' })],
      2: [job(21, { name: 'test' })],
    },
    logs: {
      31: read('jest-failure-run2.log'),
      21: read('jest-failure.log'),
    },
    compare: { files: changed },
  };
  const mock = await startMockServer(scenario);
  try {
    process.env.CI_TRIAGE_API_BASE = mock.base;
    const result = await triageRepo('o/r', { runs: 10 });
    assert.equal(result.clusters.length, 1);
    const { changedFiles } = result.clusters[0].regressionWindow;
    assert.deepEqual(changedFiles.files, changed.slice(0, 10));
    assert.equal(changedFiles.totalFiles, 12);
    assert.match(changedFiles.compareUrl, /github\.com\/o\/r\/compare\//);
  } finally {
    delete process.env.CI_TRIAGE_API_BASE;
    await mock.close();
  }
});

test('triage: a failed compare leaves the window intact', async () => {
  // The compare 404s (no common ancestor): the triage still
  // succeeds, the window still names both endpoints, and the reason
  // rides along in the JSON instead of the report pretending the
  // file list exists.
  const scenario = {
    runs: [
      run(2, { conclusion: 'failure', headSha: 'aaa0000000000000000000000000000000000000', createdAt: '2026-11-12T10:00:00Z' }),
      run(1, { conclusion: 'success', headSha: 'ccc0000000000000000000000000000000000000', createdAt: '2026-11-12T08:00:00Z' }),
    ],
    jobs: { 2: [job(21, { name: 'test' })] },
    logs: { 21: read('jest-failure.log') },
    compare: 404,
  };
  const mock = await startMockServer(scenario);
  try {
    process.env.CI_TRIAGE_API_BASE = mock.base;
    const result = await triageRepo('o/r', { runs: 10 });
    assert.equal(result.clusters.length, 1);
    const window = result.clusters[0].regressionWindow;
    assert.equal(window.lastGreen.number, 1);
    assert.equal(window.firstRed.number, 2);
    assert.equal(window.changedFiles, null);
    assert.match(window.changedFilesError, /no common ancestor/);
  } finally {
    delete process.env.CI_TRIAGE_API_BASE;
    await mock.close();
  }
});

test('triage: a regression with no green run in the window leaves the green end open', async () => {
  const scenario = {
    runs: [
      run(2, { conclusion: 'failure', headSha: 'bbb0000000000000000000000000000000000000', createdAt: '2026-11-12T14:03:15Z' }),
      run(1, { conclusion: 'failure', headSha: 'aaa0000000000000000000000000000000000000', createdAt: '2026-11-12T10:00:00Z' }),
    ],
    jobs: {
      2: [job(21, { name: 'test' })],
      1: [job(11, { name: 'test' })],
    },
    logs: {
      21: read('jest-failure-run2.log'),
      11: read('jest-failure.log'),
    },
  };
  const mock = await startMockServer(scenario);
  try {
    process.env.CI_TRIAGE_API_BASE = mock.base;
    const result = await triageRepo('o/r', { runs: 10 });
    assert.equal(result.clusters.length, 1);
    const [cluster] = result.clusters;
    assert.equal(cluster.flaky, false);
    assert.equal(cluster.regressionWindow.lastGreen, null);
    assert.equal(cluster.regressionWindow.firstRed.number, 1);
  } finally {
    delete process.env.CI_TRIAGE_API_BASE;
    await mock.close();
  }
});

test('triage: a flaky cluster carries no regression window', async () => {
  const mock = await startMockServer(flakyScenario);
  try {
    process.env.CI_TRIAGE_API_BASE = mock.base;
    const result = await triageRepo('o/r', { runs: 10 });
    assert.equal(result.clusters.length, 1);
    assert.equal(result.clusters[0].flaky, true);
    assert.equal(result.clusters[0].regressionWindow, null);
  } finally {
    delete process.env.CI_TRIAGE_API_BASE;
    await mock.close();
  }
});
