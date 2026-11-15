/**
 * Known failures (Playwright's test.fail() method, applied to
 * triage): a file that records the CI failures a team already knows
 * about and is living with, so they stop re-alerting as "real
 * regression" on every triage — and so a triage run can pass its
 * gate when the only failures left are known ones, instead of
 * failing forever on a repo with one known-broken test.
 *
 * The file holds one entry per failure signature: the signature id
 * is the 12-hex cluster id from lib/signature.mjs (the hash of the
 * normalised error lines), plus the workflow, headline, category
 * and flakiness where it was first seen. The workflow and headline
 * are audit hints for the human reading the file — matching uses
 * the signature alone, so a known failure stays known when it moves
 * to another workflow or its headline shifts slightly. Entries are
 * sorted by signature, so re-recording over an unchanged triage
 * produces no diff.
 *
 * What this is not: Playwright's test.fixme(), which does not run
 * the test at all — triage does not run tests, it reads runs, so
 * there is nothing to skip; narrowing to one workflow is what
 * --workflow already does. And it is not a strict xfail: a recorded
 * signature that stops appearing is reported as "not seen in this
 * window — possibly fixed", information, not a failure. Failing a
 * clean repo for fixing a bug would punish the fix.
 *
 * The file itself is safe to commit: it contains only signature
 * hashes and error headlines, no log contents and no tokens.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Format version written into every known-failures file. */
export const KNOWN_VERSION = 1;

/** The conventional name for a known-failures file at a repo root. */
export const KNOWN_FILENAME = '.ci-triage-known-failures.json';

export class KnownError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KnownError';
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Load a known-failures file. Returns null when the file does not
 * exist — the caller treats that as "no known failures", not an
 * error, and warns once. Throws KnownError when the file exists but
 * cannot be used: unreadable, not JSON, wrong shape, or a version
 * this tool does not understand. A corrupt file must fail loudly:
 * silently ignoring it would re-alert on every known failure, and
 * silently accepting a half-parsed one could suppress failures it
 * was never meant to.
 */
export function loadKnownFailures(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new KnownError(`cannot read known-failures file '${filePath}': ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new KnownError(`known-failures file '${filePath}' is not valid JSON: ${error.message}`);
  }
  if (!isRecord(data)) throw new KnownError(`known-failures file '${filePath}' must be a JSON object`);
  if (data.version !== KNOWN_VERSION) {
    throw new KnownError(`known-failures file '${filePath}' has version ${JSON.stringify(data.version)}, expected ${KNOWN_VERSION}`);
  }
  if (!Array.isArray(data.failures)) {
    throw new KnownError(`known-failures file '${filePath}' must have a 'failures' array`);
  }
  const entries = new Map();
  for (const entry of data.failures) {
    if (!isRecord(entry) || typeof entry.signature !== 'string' || !/^[0-9a-f]{12}$/.test(entry.signature)) {
      throw new KnownError(`known-failures file '${filePath}' has a failure without a valid signature`);
    }
    entries.set(entry.signature, {
      workflow: typeof entry.workflow === 'string' ? entry.workflow : null,
      headline: typeof entry.headline === 'string' ? entry.headline : null,
      category: typeof entry.category === 'string' ? entry.category : null,
      flaky: entry.flaky === true,
      firstSeen: typeof entry.firstSeen === 'string' ? entry.firstSeen : null,
    });
  }
  return {
    path: filePath,
    version: data.version,
    generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : null,
    generator: typeof data.generator === 'string' ? data.generator : null,
    entries,
  };
}

/**
 * Record a triage's clusters as known failures, merging with any
 * entries the file already holds — re-recording after a new failure
 * appears must not drop the ones recorded before. A signature
 * already in the file keeps its first entry (when it was first
 * triaged wins the audit trail); a new signature is added with the
 * cluster's headline, category and flakiness as audit hints.
 * Returns `{ path, count, added }` — count is the total entries in
 * the file afterwards, added is how many are new this write.
 * Refuses to write into a directory that does not exist, instead of
 * creating it — a typo in the path should error, not scatter a
 * known-failures file into a new directory.
 */
export function writeKnownFailures(filePath, clusters, { generator = null, workflow = null } = {}) {
  const dir = path.dirname(path.resolve(filePath));
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new KnownError(`cannot write known-failures file '${filePath}': directory does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) throw new KnownError(`cannot write known-failures file '${filePath}': not a directory: ${dir}`);
  const existing = loadKnownFailures(filePath);
  const entries = new Map(existing ? existing.entries : []);
  let added = 0;
  for (const cluster of clusters || []) {
    if (typeof cluster?.id !== 'string' || !/^[0-9a-f]{12}$/.test(cluster.id)) continue;
    if (entries.has(cluster.id)) continue;
    entries.set(cluster.id, {
      workflow: typeof cluster.workflow === 'string' ? cluster.workflow : workflow,
      headline: typeof cluster.headline === 'string' ? cluster.headline.slice(0, 200) : null,
      category: typeof cluster.category === 'string' ? cluster.category : null,
      flaky: cluster.flaky === true,
      firstSeen: typeof cluster.firstSeen === 'string' ? cluster.firstSeen : null,
    });
    added += 1;
  }
  const failures = [...entries.entries()]
    .map(([signature, entry]) => ({ signature, ...entry }))
    .sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));
  const data = {
    version: KNOWN_VERSION,
    generatedAt: new Date().toISOString(),
    ...(generator ? { generator } : {}),
    failures,
  };
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new KnownError(`cannot write known-failures file '${filePath}': ${error.message}`);
  }
  return { path: filePath, count: failures.length, added };
}

/** True when this cluster's signature is recorded as a known failure. */
export function isKnown(cluster, known) {
  if (!known || !cluster) return false;
  return known.entries.has(cluster.id);
}

/**
 * Split a triage's clusters into the ones the known-failures file
 * already covers and the ones it does not. The kept ones are the new
 * failures; the known ones are the triaged ones. With no known file
 * every cluster is kept.
 */
export function splitKnown(clusters, known) {
  const kept = [];
  const knownClusters = [];
  for (const cluster of clusters || []) {
    (isKnown(cluster, known) ? knownClusters : kept).push(cluster);
  }
  return { kept, known: knownClusters };
}

/**
 * The recorded failures that did not appear in this triage's
 * clusters — Playwright's test.fail() complains when a test marked
 * as expected-to-fail stops failing; the triage analogue is this
 * list, reported as information ("possibly fixed") rather than a
 * failure, so fixing a known bug never fails a clean repo.
 */
export function knownNotSeen(clusters, known) {
  if (!known) return [];
  const seen = new Set((clusters || []).map((cluster) => cluster.id));
  return [...known.entries.entries()]
    .filter(([signature]) => !seen.has(signature))
    .map(([signature, entry]) => ({ signature, ...entry }))
    .sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));
}
