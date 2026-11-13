import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyCluster, detectFlaky } from '../lib/classify.mjs';
import { extractSignature } from '../lib/signature.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => readFileSync(path.join(fixtures, name), 'utf8');

function clusterOf(fixture) {
  const sig = extractSignature(read(fixture));
  return { headline: sig.headline, evidence: sig.evidence, failures: [] };
}

test('classify: jest failure is a test failure', () => {
  const { category } = classifyCluster(clusterOf('jest-failure.log'));
  assert.equal(category, 'test');
});

test('classify: go test failure is a test failure', () => {
  const { category } = classifyCluster(clusterOf('go-test-failure.log'));
  assert.equal(category, 'test');
});

test('classify: tsc error is a build failure', () => {
  const { category } = classifyCluster(clusterOf('tsc-error.log'));
  assert.equal(category, 'build');
});

test('classify: missing module is a build failure', () => {
  const { category } = classifyCluster(clusterOf('module-not-found.log'));
  assert.equal(category, 'build');
});

test('classify: timeout is an infra failure', () => {
  const { category } = classifyCluster(clusterOf('timeout.log'));
  assert.equal(category, 'infra');
});

test('classify: lines with no signal are unknown, not a guess', () => {
  const { category, reason } = classifyCluster({ headline: 'something odd happened', evidence: ['a line', 'another line'], failures: [] });
  assert.equal(category, 'unknown');
  assert.match(reason, /no test, build or infra signal/);
});

test('flaky: same commit passed on a later run is flaky', () => {
  const cluster = {
    headline: 'x', evidence: [],
    failures: [
      { run: { headSha: 'aaa', createdAt: '2026-11-12T10:00:00Z' } },
    ],
  };
  const history = [
    { conclusion: 'failure', headSha: 'aaa', createdAt: '2026-11-12T10:00:00Z' },
    { conclusion: 'success', headSha: 'aaa', createdAt: '2026-11-12T11:00:00Z' },
  ];
  const { flaky, reason } = detectFlaky(cluster, history);
  assert.equal(flaky, true);
  assert.match(reason, /same commit passed/);
});

test('flaky: intermittent failures with successes in between are flaky', () => {
  const cluster = {
    headline: 'x', evidence: [],
    failures: [
      { run: { headSha: 'aaa', createdAt: '2026-11-12T10:00:00Z' } },
      { run: { headSha: 'bbb', createdAt: '2026-11-12T14:00:00Z' } },
    ],
  };
  const history = [
    { conclusion: 'failure', headSha: 'aaa', createdAt: '2026-11-12T10:00:00Z' },
    { conclusion: 'success', headSha: 'ccc', createdAt: '2026-11-12T12:00:00Z' },
    { conclusion: 'failure', headSha: 'bbb', createdAt: '2026-11-12T14:00:00Z' },
  ];
  assert.equal(detectFlaky(cluster, history).flaky, true);
});

test('flaky: failing on every recent run is a real regression, not flaky', () => {
  const cluster = {
    headline: 'x', evidence: [],
    failures: [
      { run: { headSha: 'aaa', createdAt: '2026-11-12T10:00:00Z' } },
      { run: { headSha: 'bbb', createdAt: '2026-11-12T14:00:00Z' } },
    ],
  };
  const history = [
    { conclusion: 'failure', headSha: 'aaa', createdAt: '2026-11-12T10:00:00Z' },
    { conclusion: 'failure', headSha: 'bbb', createdAt: '2026-11-12T14:00:00Z' },
  ];
  const { flaky, reason } = detectFlaky(cluster, history);
  assert.equal(flaky, false);
  assert.match(reason, /real regression/);
});
