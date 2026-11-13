/**
 * Error signatures from GitHub Actions job logs.
 *
 * The idea, in one sentence: the real cause of a CI failure is
 * usually not the last line, so find the lines that actually say
 * what broke, strip everything that varies between runs (timestamps,
 * paths, hashes, versions, counts), and hash what is left. Two
 * failures with the same signature are the same root cause; two with
 * different signatures are not.
 *
 * A signature is { id, headline, evidence }: id is a 12-hex hash of
 * the normalised error lines (the cluster key), headline is the first
 * error line with only the noisiest bits stripped (human-readable),
 * evidence is up to 5 raw lines around the first error line so a
 * person can check the verdict without re-downloading the log.
 */
import { createHash } from 'node:crypto';

/** GitHub log lines start with an RFC 3339 timestamp; strip it. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*/;
/** ANSI colour codes. */
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
/** `##[group]`, `##[error]`, `##[endgroup]` markers. */
const GROUP_MARKER_RE = /^##\[[a-z]+\]\s*/i;
/** `::error file=...,line=1::message` workflow-command annotations. */
const ANNOTATION_RE = /^::(error|warning|notice)(?:\s+[^:]*)?::/;

const ERROR_PATTERNS = [
  /::error::/i,
  /##\[error\]/i,
  /error:/i,
  /\bERROR\b/,
  /AssertionError/,
  /Traceback \(most recent call last\)/,
  /\bpanic:/,
  /\bfatal:/i,
  /FAILED\b/,
  /\bFAIL\b/,
  /✕|✖/,
  /npm ERR!/,
  /Module not found/i,
  /Cannot find module/i,
  /command not found/i,
  /No such file or directory/i,
  /BUILD FAILED/i,
  /Tests?:?\s*\d+\s*(failed|failing)/i,
  /Test Suites?:?\s*\d+\s*failed/i,
  /exit code \d+/i,
  /Process completed with exit code/i,
  /The process '.*' failed with exit code/i,
  /make: \*\*\*/,
  /error TS\d+/,
  /SyntaxError/,
  /ReferenceError/,
  /TypeError:/,
  /timed? ?out/i,
  /The operation was canceled/i,
  /maximum execution time/i,
  /No space left on device/i,
  /could not resolve host/i,
  /connection (refused|reset|timed out)/i,
  /rate limit/i,
];

/** Lines that are never the cause, even if they match a pattern. */
const NOISE_LINES = [
  /^npm notice\b/,
  /^npm WARN\b/,
  /^warning:/i,
  /^##\[warning\]/i,
  /^::warning::/i,
];

/**
 * Strip one line down to what identifies the failure: timestamps,
 * ANSI codes and workflow-command prefixes go; the message stays.
 */
export function cleanLine(line) {
  let out = line.replace(ANSI_RE, '');
  out = out.replace(TIMESTAMP_RE, '');
  out = out.replace(GROUP_MARKER_RE, '');
  out = out.replace(ANNOTATION_RE, '');
  return out.trim();
}

/**
 * Normalise a line for grouping: replace everything that varies
 * between runs with a placeholder, then lowercase and collapse
 * whitespace. Two lines that differ only in a path, a hash, a version
 * or a count normalise to the same string.
 */
export function normalizeLine(line) {
  let out = cleanLine(line);
  // Windows and POSIX absolute paths, and the runner workdir.
  out = out.replace(/[A-Za-z]:\\[^\s"'`,;]*/g, '<path>');
  out = out.replace(/\/home\/runner\/work\/[^\s"'`,;]*/g, '<workdir>');
  out = out.replace(/\/[^\s"'`,;:]*\/[^\s"'`,;:]*/g, (m) => (m.includes('/') ? '<path>' : m));
  // Temp directories and cache paths.
  out = out.replace(/\/(tmp|var\/folders)\/[^\s"'`,;]*/g, '<tmp>');
  // UUIDs, long hex hashes, short hashes after a word boundary.
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');
  out = out.replace(/\b[0-9a-f]{40}\b/gi, '<hash>');
  out = out.replace(/\b[0-9a-f]{7,39}\b/gi, (m) => (/[0-9]/.test(m) && /[a-f]/.test(m) ? '<hash>' : m));
  // Versions: v1.2.3, 1.2.3, node 20.11.0.
  out = out.replace(/\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g, '<version>');
  // Durations and counts: 123ms, 12.3s, 1,234, (3 failed).
  out = out.replace(/\b\d[\d,]*(\.\d+)?\s?(ms|s|m|h)\b/g, '<duration>');
  out = out.replace(/\b\d[\d,]*\b/g, '<n>');
  // file:line:col positions.
  out = out.replace(/:\d+:\d+/g, ':<n>:<n>');
  out = out.replace(/line \d+/gi, 'line <n>');
  // Test counts in parentheses.
  out = out.replace(/\(\d+ (failed|passed|skipped)\)/gi, '(<n> $1)');
  return out.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isErrorLine(line) {
  if (NOISE_LINES.some((re) => re.test(line))) return false;
  return ERROR_PATTERNS.some((re) => re.test(line));
}

function scoreLine(line) {
  // The most specific lines win: an annotation or a named error beats
  // a bare "FAIL", which beats a generic "exit code".
  let score = 0;
  if (/::error::|##\[error\]/.test(line)) score += 4;
  if (/AssertionError|Traceback|panic:|error TS\d+|SyntaxError|ReferenceError/.test(line)) score += 3;
  if (/npm ERR!|Module not found|Cannot find module|BUILD FAILED/.test(line)) score += 3;
  if (/\bFAIL\b|FAILED|✕|✖/.test(line)) score += 2;
  if (/error:/i.test(line)) score += 2;
  if (/timed? ?out|operation was canceled|maximum execution time|No space left|connection (refused|reset)|rate limit/i.test(line)) score += 3;
  if (/exit code|Process completed/.test(line)) score += 1;
  return score;
}

/**
 * Extract a signature from a whole job log. Returns null when the log
 * is empty. When no line matches an error pattern, the tail of the
 * log (the last 5 non-empty lines) is the signature basis — a failed
 * job's tail usually holds the failure summary.
 */
export function extractSignature(logText, { label = '' } = {}) {
  if (typeof logText !== 'string' || logText.trim() === '') return null;
  const rawLines = logText.split(/\r?\n/);
  const cleaned = rawLines.map((line) => cleanLine(line));
  const candidates = [];
  cleaned.forEach((line, index) => {
    if (line === '') return;
    if (isErrorLine(line)) candidates.push({ line, index, score: scoreLine(line) });
  });
  let picked;
  let headlineLine;
  if (candidates.length > 0) {
    // Highest score wins; ties break towards the earliest line, so
    // the first real error beats a later repeat of it.
    candidates.sort((a, b) => b.score - a.score || a.index - b.index);
    const best = candidates[0];
    picked = candidates
      .filter((c) => c.index >= best.index)
      .sort((a, b) => a.index - b.index)
      .slice(0, 3);
    headlineLine = picked[0].line;
  } else {
    const tail = cleaned
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line !== '')
      .slice(-5);
    picked = tail;
    // In the tail fallback the last line is the most informative
    // (the final state), so it is the headline, not the first.
    headlineLine = tail.length > 0 ? tail[tail.length - 1].line : '';
  }
  const normalised = picked.map(({ line }) => normalizeLine(line)).filter((line) => line !== '');
  if (normalised.length === 0) return null;
  const id = createHash('sha256').update(normalised.join('\n')).digest('hex').slice(0, 12);
  const headline = headlineLine.length > 200 ? `${headlineLine.slice(0, 197)}…` : headlineLine;
  // Evidence: the raw lines around the first picked line, so the
  // verdict can be checked without re-downloading the log.
  const firstIndex = picked[0].index;
  const evidence = cleaned
    .slice(Math.max(0, firstIndex - 1), firstIndex + 4)
    .filter((line) => line !== '')
    .map((line) => (line.length > 200 ? `${line.slice(0, 197)}…` : line))
    .slice(0, 5);
  return { id, headline, evidence, label };
}

/** Group failures by signature id, preserving first-seen order. */
export function clusterFailures(failures) {
  const clusters = new Map();
  for (const failure of failures) {
    const sig = failure.signature;
    if (!sig) continue;
    let cluster = clusters.get(sig.id);
    if (!cluster) {
      cluster = { id: sig.id, headline: sig.headline, evidence: sig.evidence, failures: [] };
      clusters.set(sig.id, cluster);
    }
    cluster.failures.push(failure);
  }
  return [...clusters.values()];
}
