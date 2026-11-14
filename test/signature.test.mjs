import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanLine, clusterFailures, extractSignature, normalizeLine } from '../lib/signature.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => readFileSync(path.join(fixtures, name), 'utf8');

test('signature: the same failure in two runs has the same id', () => {
  const a = extractSignature(read('jest-failure.log'));
  const b = extractSignature(read('jest-failure-run2.log'));
  assert.ok(a && b);
  // The two logs differ only in timestamps, a line number, and test
  // counts — everything the normaliser strips. Same root cause, so
  // the same signature.
  assert.equal(a.id, b.id);
  assert.ok(a.headline.includes('Button'));
});

test('signature: different failures have different ids', () => {
  const ids = ['jest-failure.log', 'tsc-error.log', 'timeout.log', 'module-not-found.log', 'go-test-failure.log']
    .map((name) => extractSignature(read(name)).id);
  assert.equal(new Set(ids).size, ids.length);
});

test('signature: an empty log has no signature', () => {
  assert.equal(extractSignature(''), null);
  assert.equal(extractSignature('   \n  \n'), null);
});

test('signature: the location is the failing file and line, from the whole log', () => {
  // tsc names the file on the error line itself.
  assert.deepEqual(extractSignature(read('tsc-error.log')).location, { file: 'src/utils/format.ts', line: 18 });
  // Jest names it in a stack frame several lines below the FAIL line,
  // outside the 5-line evidence window — the scan must reach it.
  assert.deepEqual(extractSignature(read('jest-failure.log')).location, { file: 'src/components/Button.test.tsx', line: 42 });
  // Go reports a bare filename with no directory — no repo location.
  assert.equal(extractSignature(read('go-test-failure.log')).location, null);
  // No file:line anywhere — a timeout has no code location.
  assert.equal(extractSignature(read('timeout.log')).location, null);
});

test('signature: the headline is a human-readable error line, not a hash', () => {
  const sig = extractSignature(read('tsc-error.log'));
  assert.ok(sig.headline.includes('TS2322'));
  assert.ok(sig.headline.includes('format.ts'));
  assert.ok(sig.evidence.length > 0);
  assert.ok(sig.evidence.some((line) => line.includes('TS2322')));
});

test('signature: a log with no error pattern falls back to its tail', () => {
  const sig = extractSignature('starting up\nworking...\nall done\n');
  assert.ok(sig);
  assert.ok(sig.headline.includes('all done'));
});

test('signature: cleanLine strips timestamps, ANSI codes and markers', () => {
  assert.equal(cleanLine('2026-11-12T14:03:11.1234567Z ##[group]Run npm test'), 'Run npm test');
  assert.equal(cleanLine('\u001b[31mError: boom\u001b[0m'), 'Error: boom');
  assert.equal(cleanLine('::error file=x.js,line=1::something broke'), 'something broke');
  assert.equal(cleanLine('##[error]Process completed with exit code 1.'), 'Process completed with exit code 1.');
});

test('signature: normalizeLine collapses paths, hashes, versions and counts', () => {
  assert.equal(normalizeLine("Module not found: Can't resolve 'x' in '/home/runner/work/app/app/src/pages'"), normalizeLine("Module not found: Can't resolve 'x' in '/home/runner/work/other/other/src/pages'"));
  assert.equal(normalizeLine('Tests: 1 failed, 47 passed, 48 total'), normalizeLine('Tests: 3 failed, 12 passed, 15 total'));
  assert.equal(normalizeLine('at foo (src/a.ts:42:18)'), normalizeLine('at foo (src/a.ts:57:22)'));
  assert.equal(normalizeLine('node v20.11.0'), normalizeLine('node v22.5.1'));
  assert.notEqual(normalizeLine('Error: foo'), normalizeLine('Error: bar'));
});

test('signature: clustering groups same ids and keeps first-seen order', () => {
  const a = extractSignature(read('jest-failure.log'));
  const b = extractSignature(read('jest-failure-run2.log'));
  const c = extractSignature(read('tsc-error.log'));
  const clusters = clusterFailures([
    { signature: a }, { signature: b }, { signature: c }, { signature: null },
  ]);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].failures.length, 2);
  assert.equal(clusters[1].failures.length, 1);
});
