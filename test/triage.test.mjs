import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { job, run, startMockServer } from './mock-server.mjs';
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
