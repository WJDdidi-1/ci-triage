/**
 * Classification of a failure cluster.
 *
 * Two questions, in order:
 *
 *   1. What kind of failure is it — test, build, infra, or unknown?
 *      Scored from the headline and evidence lines: the strongest
 *      matching pattern set wins. A cluster is never classified from
 *      one word alone — every category needs a real signal, and when
 *      nothing signals, the answer is "unknown" rather than a guess.
 *
 *   2. Is it flaky? A cluster is flaky only when the run history
 *      shows it: the same signature failed on a commit that later
 *      passed on retry, or it fails intermittently while the same
 *      workflow usually passes. A signature that fails on every run
 *      is a real regression, not flakiness — that distinction is the
 *      whole point of looking at history instead of one log.
 *
 * Categories: 'test' | 'build' | 'infra' | 'unknown'.
 */

const CATEGORY_PATTERNS = {
  test: [
    /AssertionError/i,
    /expected .* to (be|equal|match|contain)/i,
    /\bFAIL\b.*\.(test|spec)\.[jt]sx?/i,
    /FAIL\s+\S/,
    /✕|✖/,
    /Tests?:?\s*\d+\s*(failed|failing)/i,
    /Test Suites?:?\s*\d+\s*failed/i,
    /\b(jest|vitest|mocha|pytest|go test|dotnet test|rspec|minitest|phpunit|ctest|gradle test)\b/i,
    /●.*›/,
    /test (suite )?failed/i,
    /passing.*failing/i,
  ],
  build: [
    /error TS\d+/,
    /Module not found/i,
    /Cannot find module/i,
    /\btsc\b.*error/i,
    /\b(webpack|rollup|esbuild|vite build|tsc)\b.*(error|failed)/i,
    /BUILD FAILED/i,
    /Compilation failed/i,
    /SyntaxError/,
    /undefined reference/i,
    /\blink(ed|er)?\b.*error/i,
    /\b(gcc|clang|rustc|cargo (build|check)|go build|gradle|mvn|maven)\b/i,
    /Cannot resolve/i,
    /Failed to compile/i,
  ],
  infra: [
    /timed? ?out/i,
    /The operation was canceled/i,
    /No space left on device/i,
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/,
    /Could not resolve host/i,
    /Connection (refused|reset|timed out)/i,
    /rate limit/i,
    /\b429\b/,
    /\b(network|DNS|TLS|SSL|certificate)\b.*(error|fail)/i,
    /runner.*(lost|offline|disconnected)/i,
    /lost communication/i,
    /disk full|quota exceeded/i,
    /Resource temporarily unavailable/i,
    /read-only file system/i,
    /cache.*(miss|failed to (download|restore))/i,
  ],
};

function scoreCategory(text, patterns) {
  let score = 0;
  for (const re of patterns) {
    if (re.test(text)) score += 1;
  }
  return score;
}

/**
 * Classify one cluster from its headline and evidence lines.
 * Returns { category, reason } — reason is the pattern that decided
 * it, so the verdict can be checked.
 */
export function classifyCluster(cluster) {
  const text = [cluster.headline, ...(cluster.evidence || [])].join('\n');
  const scores = {
    test: scoreCategory(text, CATEGORY_PATTERNS.test),
    build: scoreCategory(text, CATEGORY_PATTERNS.build),
    infra: scoreCategory(text, CATEGORY_PATTERNS.infra),
  };
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (best[1] === 0) {
    return { category: 'unknown', reason: 'no test, build or infra signal in the error lines' };
  }
  // A tie means the lines genuinely say two things at once (a test
  // that fails because the build broke, for instance) — report the
  // tie instead of pretending one won.
  const tied = Object.entries(scores).filter(([, s]) => s === best[1]).map(([c]) => c);
  if (tied.length > 1) {
    return { category: best[0], reason: `tied signals (${tied.join(' / ')}) — picked ${best[0]} by order test > build > infra` };
  }
  const label = { test: 'test-runner failure', build: 'build/compile error', infra: 'infrastructure or network failure' }[best[0]];
  return { category: best[0], reason: `${scores[best[0]]} ${label} signal${scores[best[0]] > 1 ? 's' : ''} in the error lines` };
}

/**
 * Flaky detection from run history.
 *
 * history is the recent runs of the same workflow and branch, newest
 * first: [{ conclusion, headSha, createdAt }]. A cluster is flaky
 * when either:
 *   - the same commit that failed later passed (a retry or a
 *     re-run of the same head SHA succeeded), or
 *   - the signature fails in at least two runs while successful runs
 *     of the same workflow and branch sit between them (it fails
 *     intermittently while the workflow usually passes).
 *
 * A signature that fails on every recent run is not flaky — it is a
 * real regression, and the function says so.
 */
export function detectFlaky(cluster, history) {
  const failingShas = new Set(cluster.failures.map((f) => f.run.headSha).filter(Boolean));
  const successes = history.filter((run) => run.conclusion === 'success');
  for (const sha of failingShas) {
    const sameShaSuccess = successes.filter((run) => run.headSha === sha);
    if (sameShaSuccess.length === 0) continue;
    // Same code, two outcomes: the failure does not follow the
    // code. A success after the failure is the classic retry-pass;
    // a success before it is the same non-determinism seen the
    // other way round.
    const earliestFail = Math.min(
      ...cluster.failures.filter((f) => f.run.headSha === sha).map((f) => new Date(f.run.createdAt).getTime()),
    );
    const later = sameShaSuccess.some((run) => new Date(run.createdAt).getTime() > earliestFail);
    return {
      flaky: true,
      reason: later
        ? 'same commit passed on a later run — the failure does not follow the code'
        : 'same commit passed on another run — the failure does not follow the code',
    };
  }
  if (cluster.failures.length >= 2 && successes.length > 0) {
    const firstFail = Math.min(...cluster.failures.map((f) => new Date(f.run.createdAt).getTime()));
    const lastFail = Math.max(...cluster.failures.map((f) => new Date(f.run.createdAt).getTime()));
    const between = successes.filter((run) => {
      const t = new Date(run.createdAt).getTime();
      return t > firstFail && t < lastFail;
    });
    if (between.length > 0) {
      return { flaky: true, reason: 'fails intermittently while the same workflow passes in between' };
    }
  }
  return { flaky: false, reason: 'fails on every recent run — looks like a real regression, not flakiness' };
}
