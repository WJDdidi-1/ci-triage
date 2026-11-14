import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { formatAnnotations, formatReport, formatSummary, writeReportFile, writeStepSummary } from '../lib/report.mjs';
import { tempDir } from '../scripts/support.mjs';

const clustered = {
  repo: 'acme/widgets',
  workflow: null,
  branch: null,
  window: { runsListed: 2, failedRuns: 2 },
  clusters: [
    {
      category: 'test',
      count: 2,
      flaky: false,
      headline: 'FAIL src/components/Button.test.tsx',
      categoryReason: '3 test-runner failure signals in the error lines',
      flakyReason: 'fails on every recent run — looks like a real regression, not flakiness',
      firstSeen: '2026-11-12T10:00:00.000Z',
      lastSeen: '2026-11-12T14:03:00.000Z',
      runs: [{ number: 2, job: 'test' }, { number: 1, job: 'test' }],
      evidence: ['FAIL src/components/Button.test.tsx', 'expect(received).toBe(expected)'],
    },
    {
      category: 'infra',
      count: 1,
      flaky: true,
      headline: 'Error: timed out after 3600s',
      categoryReason: 'timeout signal in the error lines',
      flakyReason: 'the same commit passed on a later run',
      firstSeen: '2026-11-12T09:00:00.000Z',
      lastSeen: '2026-11-12T09:00:00.000Z',
      runs: [{ number: 1, job: 'build' }],
      evidence: [],
    },
  ],
  failures: [
    { signature: 'sig-a', logError: null },
    { signature: 'sig-a', logError: null },
    { signature: 'sig-b', logError: null },
    { signature: null, logError: 'log expired' },
  ],
  fetchedAt: '2026-11-13T00:00:00.000Z',
};

test('summary: formatSummary renders the ranked report as Markdown', () => {
  const md = formatSummary(clustered);
  assert.match(md, /^## ci-triage — acme\/widgets\n/m);
  assert.match(md, /\*\*Root causes: 2 \(1 real, 1 flaky\)\*\*/);
  assert.match(md, /^### #1 test · 2 runs · real regression$/m);
  assert.match(md, /\*\*FAIL src\/components\/Button\.test\.tsx\*\*/);
  assert.match(md, /runs: #2 \(test\), #1 \(test\)/);
  assert.match(md, /^- FAIL src\/components\/Button\.test\.tsx$/m);
  assert.match(md, /^### #2 infra · 1 run · FLAKY$/m);
  assert.match(md, /Note: 1 failed job had no readable log/);
  assert.match(md, /Reason: log expired/);
  assert.match(md, /Fetched: 2026-11-13T00:00:00\.000Z/);
});

test('report: the top-clusters share line says how much the top two cover', () => {
  // Clusters cover 2 + 1 of 4 failures: the top two are 75% of the mass.
  const text = formatReport(clustered);
  assert.match(text, /Root causes: 2 \(1 real, 1 flaky\)/);
  assert.match(text, /Top 2 root causes cover 3 of 4 failures \(75%\)/);
  const md = formatSummary(clustered);
  assert.match(md, /\*\*Top 2 root causes cover 3 of 4 failures \(75%\)\*\*/);
});

test('report: no share line with fewer than two clusters', () => {
  const one = { ...clustered, clusters: clustered.clusters.slice(0, 1) };
  assert.doesNotMatch(formatReport(one), /Top \d+ root causes cover/);
  assert.doesNotMatch(formatSummary(one), /Top \d+ root causes cover/);
  const none = { ...clustered, clusters: [], failures: [] };
  assert.doesNotMatch(formatReport(none), /Top \d+ root causes cover/);
  assert.doesNotMatch(formatSummary(none), /Top \d+ root causes cover/);
});

test('summary: --top limits the clusters and notes the remainder', () => {
  const md = formatSummary(clustered, { top: 1 });
  assert.match(md, /^### #1 test/m);
  assert.doesNotMatch(md, /^### #2/m);
  assert.match(md, /… and 1 more root cause \(use --top 2 to see them all\)/);
});

test('summary: a clean window says green, an unreadable one says UNKNOWN', () => {
  const clean = formatSummary({ ...clustered, clusters: [], failures: [] });
  assert.match(clean, /No failures found in this window — CI is green/);
  const unknown = formatSummary({
    ...clustered,
    clusters: [],
    failures: [{ signature: null, logError: 'downloading this job log needs a GitHub token (403)' }],
  });
  assert.match(unknown, /No clusters:/);
  assert.match(unknown, /needs a GitHub token \(403\)/);
});

test('report: writeReportFile writes the Markdown summary to a file', () => {
  const dir = tempDir('ci-triage-report-');
  const file = path.join(dir, 'triage.md');
  assert.equal(writeReportFile(clustered, file), true);
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /^## ci-triage — acme\/widgets\n/m);
  assert.match(content, /\*\*Root causes: 2 \(1 real, 1 flaky\)\*\*/);
  assert.match(content, /^### #1 test · 2 runs · real regression$/m);
  assert.match(content, /\*\*Top 2 root causes cover 3 of 4 failures \(75%\)\*\*/);
  assert.match(content, /Fetched: 2026-11-13T00:00:00\.000Z/);
});

test('report: writeReportFile honours --top and writes the same Markdown as the summary', () => {
  const dir = tempDir('ci-triage-report-top-');
  const file = path.join(dir, 'triage.md');
  assert.equal(writeReportFile(clustered, file, { top: 1 }), true);
  const content = fs.readFileSync(file, 'utf8');
  assert.equal(content, `${formatSummary(clustered, { top: 1 })}\n`);
  assert.doesNotMatch(content, /^### #2/m);
  assert.match(content, /… and 1 more root cause/);
});

test('report: writeReportFile fails loudly on an unwritable path', () => {
  const dir = tempDir('ci-triage-report-bad-');
  const file = path.join(dir, 'missing-dir', 'triage.md');
  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    assert.equal(writeReportFile(clustered, file), false);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /could not write report to/);
});

test('summary: writeStepSummary is a no-op without GITHUB_STEP_SUMMARY', () => {
  assert.equal(writeStepSummary(clustered, { env: {} }), false);
  assert.equal(writeStepSummary(clustered, { env: { GITHUB_STEP_SUMMARY: '' } }), false);
});

test('summary: writeStepSummary appends to existing content, never replaces it', () => {
  const dir = tempDir('ci-triage-summary-');
  const file = path.join(dir, 'summary.md');
  fs.writeFileSync(file, '# Previous step\n\nSome earlier output.\n');
  const env = { GITHUB_STEP_SUMMARY: file };
  assert.equal(writeStepSummary(clustered, { env }), true);
  const first = fs.readFileSync(file, 'utf8');
  assert.ok(first.startsWith('# Previous step\n\nSome earlier output.\n'));
  assert.match(first, /## ci-triage — acme\/widgets/);
  // A second write appends a second copy instead of replacing the first.
  assert.equal(writeStepSummary(clustered, { env }), true);
  const second = fs.readFileSync(file, 'utf8');
  assert.equal(second.match(/## ci-triage — acme\/widgets/g).length, 2);
});

test('summary: an unwritable summary path warns instead of throwing', () => {
  const dir = tempDir('ci-triage-summary-bad-');
  const file = path.join(dir, 'missing-dir', 'summary.md');
  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    assert.equal(writeStepSummary(clustered, { env: { GITHUB_STEP_SUMMARY: file } }), false);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /could not write the step summary/);
});

test('annotations: a real cluster is ::error::, a flaky one is ::warning::', () => {
  const lines = formatAnnotations(clustered).split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^::error title=ci-triage acme\/widgets — #1 test · 2 runs · real regression::/);
  assert.match(lines[0], /FAIL src\/components\/Button\.test\.tsx\. Runs: #2 \(test\), #1 \(test\)\./);
  assert.match(lines[1], /^::warning title=ci-triage acme\/widgets — #2 infra · 1 run · flaky::/);
  assert.match(lines[1], /Error: timed out after 3600s\. Runs: #1 \(build\)\./);
});

test('annotations: an unknown-category cluster is ::warning::, never ::error::', () => {
  const result = {
    ...clustered,
    clusters: [{ ...clustered.clusters[0], category: 'unknown', flaky: false }],
    failures: [],
  };
  const lines = formatAnnotations(result).split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::warning title=/);
  assert.match(lines[0], /unknown · 2 runs · real regression/);
});

test('annotations: workflow-command escaping covers %, CR and LF in the message, and : and , in the title', () => {
  const result = {
    repo: 'a,b/c:d',
    workflow: null,
    branch: null,
    window: { runsListed: 1, failedRuns: 1 },
    clusters: [{
      category: 'test',
      count: 1,
      flaky: false,
      headline: '100% failed\nsecond line\rthird',
      categoryReason: 'reason',
      flakyReason: 'flaky reason',
      firstSeen: '2026-11-12T10:00:00.000Z',
      lastSeen: '2026-11-12T10:00:00.000Z',
      runs: [{ number: 1, job: 'test' }],
      evidence: [],
    }],
    failures: [{ signature: 'sig', logError: null }],
    fetchedAt: '2026-11-13T00:00:00.000Z',
  };
  const line = formatAnnotations(result);
  assert.match(line, /^::error title=ci-triage a%2Cb\/c%3Ad — #1 test · 1 run · real regression::/);
  assert.match(line, /100%25 failed%0Asecond line%0Dthird/);
  assert.doesNotMatch(line, /[^%]%(?![0-9A-F]{2})/);
});

test('annotations: a clean window emits nothing; unreadable logs emit one warning', () => {
  assert.equal(formatAnnotations({ ...clustered, clusters: [], failures: [] }), '');
  const unreadable = {
    ...clustered,
    clusters: [],
    failures: [
      { signature: null, logError: 'log expired' },
      { signature: null, logError: 'log expired' },
    ],
  };
  const line = formatAnnotations(unreadable);
  assert.match(line, /^::warning title=ci-triage acme\/widgets — logs unreadable::/);
  assert.match(line, /2 failed jobs found, but their logs could not be read\. Reason: log expired/);
});

test('annotations: --top limits the lines to the top clusters', () => {
  const lines = formatAnnotations(clustered, { top: 1 }).split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /#1 test · 2 runs/);
});

test('annotations: at most 10 lines per level — GitHub drops the rest silently', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({
    ...clustered.clusters[0],
    headline: `failure ${i + 1}`,
    runs: [{ number: i + 1, job: 'test' }],
  }));
  const result = { ...clustered, clusters: many, failures: [] };
  assert.equal(formatAnnotations(result).split('\n').length, 10);
});

function oneClusterResult(evidence) {
  return {
    ...clustered,
    clusters: [{ ...clustered.clusters[0], evidence }],
    failures: [],
  };
}

test('annotations: a tsc file:line in the evidence pins the annotation to that file and line', () => {
  const line = formatAnnotations(oneClusterResult([
    'src/utils/format.ts:18:7 - error TS2322: Type \'string\' is not assignable to type \'number\'.',
    'Found 1 error in src/utils/format.ts:18',
  ]));
  assert.match(line, /^::error file=src\/utils\/format\.ts,line=18,title=ci-triage acme\/widgets — #1 test · 2 runs · real regression::/);
});

test('annotations: a Jest stack frame pins to the test file and line', () => {
  const line = formatAnnotations(oneClusterResult([
    'FAIL src/components/Button.test.tsx',
    'at Object.<anonymous> (src/components/Button.test.tsx:42:18)',
  ]));
  assert.match(line, /^::error file=src\/components\/Button\.test\.tsx,line=42,title=/);
});

test('annotations: a bare filename, an absolute runner path, or a node_modules frame stays unpinned', () => {
  // Go reports `config_test.go:88` with no directory — no repo
  // location to pin, so the annotation stays on the run's panel.
  const go = formatAnnotations(oneClusterResult(['config_test.go:88: expected 3 retries, got 0']));
  assert.doesNotMatch(go, / file=/);
  assert.match(go, /^::error title=/);
  // An absolute runner path is not a repo-relative path.
  const abs = formatAnnotations(oneClusterResult(['/home/runner/work/acme/widgets/src/foo.ts:12:3 - error TS2322: boom']));
  assert.doesNotMatch(abs, / file=/);
  // A node_modules frame is not the user's code.
  const nm = formatAnnotations(oneClusterResult(['at foo (node_modules/jest/bin/jest.js:10:5)']));
  assert.doesNotMatch(nm, / file=/);
});

test('annotations: a node_modules frame is skipped in favour of a later real file', () => {
  const line = formatAnnotations(oneClusterResult([
    'at foo (node_modules/jest/bin/jest.js:10:5)',
    'at Object.<anonymous> (src/components/Button.test.tsx:42:18)',
  ]));
  assert.match(line, /^::error file=src\/components\/Button\.test\.tsx,line=42,title=/);
});
