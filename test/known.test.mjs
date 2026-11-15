import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from '../scripts/support.mjs';
import {
  KNOWN_FILENAME, KNOWN_VERSION, KnownError, isKnown, knownNotSeen,
  loadKnownFailures, splitKnown, writeKnownFailures,
} from '../lib/known.mjs';

const sig = (n) => n.toString(16).padStart(12, '0');
const cluster = (id, overrides = {}) => ({
  id, headline: overrides.headline ?? `FAIL example-${id}`, category: overrides.category ?? 'test',
  flaky: overrides.flaky ?? false, firstSeen: overrides.firstSeen ?? '2026-11-12T10:00:00Z',
});

test('known: load returns null for a missing file', async () => {
  const dir = await tempDir('ci-triage-known-');
  try {
    assert.equal(loadKnownFailures(path.join(dir, KNOWN_FILENAME)), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('known: write then load round-trips, entries sorted by signature', async () => {
  const dir = await tempDir('ci-triage-known-');
  try {
    const file = path.join(dir, KNOWN_FILENAME);
    const out = writeKnownFailures(file, [cluster(sig(0xabc)), cluster(sig(0x123))], { workflow: 'CI' });
    assert.equal(out.count, 2);
    assert.equal(out.added, 2);
    const loaded = loadKnownFailures(file);
    assert.equal(loaded.version, KNOWN_VERSION);
    assert.equal(loaded.entries.size, 2);
    assert.deepEqual([...loaded.entries.keys()], [sig(0x123), sig(0xabc)]);
    assert.equal(loaded.entries.get(sig(0xabc)).workflow, 'CI');
    assert.equal(loaded.entries.get(sig(0xabc)).headline, 'FAIL example-000000000abc');
    assert.equal(loaded.entries.get(sig(0xabc)).flaky, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('known: write merges with existing entries instead of dropping them', async () => {
  const dir = await tempDir('ci-triage-known-');
  try {
    const file = path.join(dir, KNOWN_FILENAME);
    writeKnownFailures(file, [cluster(sig(0x111))], { workflow: 'CI' });
    const out = writeKnownFailures(file, [cluster(sig(0x222))], { workflow: 'CI' });
    assert.equal(out.count, 2);
    assert.equal(out.added, 1);
    assert.equal(loadKnownFailures(file).entries.size, 2);
    // Re-recording the same signature adds nothing and keeps the
    // first entry (when it was first triaged wins the audit trail).
    const again = writeKnownFailures(file, [cluster(sig(0x111), { headline: 'changed headline' })], { workflow: 'other' });
    assert.equal(again.count, 2);
    assert.equal(again.added, 0);
    assert.equal(loadKnownFailures(file).entries.get(sig(0x111)).headline, 'FAIL example-000000000111');
    assert.equal(loadKnownFailures(file).entries.get(sig(0x111)).workflow, 'CI');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('known: matching is by signature alone — a known failure stays known in another workflow', async () => {
  const dir = await tempDir('ci-triage-known-');
  try {
    const file = path.join(dir, KNOWN_FILENAME);
    writeKnownFailures(file, [cluster(sig(0xabc))], { workflow: 'CI' });
    const known = loadKnownFailures(file);
    assert.equal(isKnown(cluster(sig(0xabc)), known), true);
    assert.equal(isKnown(cluster(sig(0xdef)), known), false);
    assert.equal(isKnown(cluster(sig(0xabc)), null), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('known: splitKnown separates kept from recorded clusters', () => {
  const known = { entries: new Map([[sig(0xabc), {}]]) };
  const { kept, known: knownClusters } = splitKnown([cluster(sig(0xabc)), cluster(sig(0xdef))], known);
  assert.deepEqual(kept.map((c) => c.id), [sig(0xdef)]);
  assert.deepEqual(knownClusters.map((c) => c.id), [sig(0xabc)]);
  assert.deepEqual(splitKnown([cluster(sig(0xabc))], null).kept.map((c) => c.id), [sig(0xabc)]);
});

test('known: knownNotSeen lists recorded signatures absent from the window', () => {
  const known = {
    entries: new Map([
      [sig(0xabc), { headline: 'old failure', workflow: 'CI' }],
      [sig(0xdef), { headline: 'still failing', workflow: 'CI' }],
    ]),
  };
  const notSeen = knownNotSeen([cluster(sig(0xdef))], known);
  assert.deepEqual(notSeen.map((e) => e.signature), [sig(0xabc)]);
  assert.equal(notSeen[0].headline, 'old failure');
  assert.deepEqual(knownNotSeen([cluster(sig(0xabc)), cluster(sig(0xdef))], known), []);
  assert.deepEqual(knownNotSeen([], null), []);
});

test('known: a corrupt file fails loudly, never silently unsuppressed', async () => {
  const dir = await tempDir('ci-triage-known-');
  try {
    const badJson = path.join(dir, 'bad.json');
    fs.writeFileSync(badJson, '{not json', 'utf8');
    assert.throws(() => loadKnownFailures(badJson), KnownError);
    const badVersion = path.join(dir, 'bad-version.json');
    fs.writeFileSync(badVersion, JSON.stringify({ version: 99, failures: [] }), 'utf8');
    assert.throws(() => loadKnownFailures(badVersion), KnownError);
    const badShape = path.join(dir, 'bad-shape.json');
    fs.writeFileSync(badShape, JSON.stringify({ version: 1, failures: [{ signature: 'xyz' }] }), 'utf8');
    assert.throws(() => loadKnownFailures(badShape), KnownError);
    const notObject = path.join(dir, 'not-object.json');
    fs.writeFileSync(notObject, JSON.stringify([1, 2]), 'utf8');
    assert.throws(() => loadKnownFailures(notObject), KnownError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('known: write refuses a directory that does not exist', async () => {
  const dir = await tempDir('ci-triage-known-');
  try {
    assert.throws(
      () => writeKnownFailures(path.join(dir, 'no-such-dir', KNOWN_FILENAME), [cluster(sig(0xabc))]),
      KnownError,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('known: clusters without a valid signature id are never recorded', async () => {
  const dir = await tempDir('ci-triage-known-');
  try {
    const file = path.join(dir, KNOWN_FILENAME);
    const out = writeKnownFailures(file, [{ id: 'not-a-signature' }, null, cluster(sig(0xabc))]);
    assert.equal(out.count, 1);
    assert.equal(out.added, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
