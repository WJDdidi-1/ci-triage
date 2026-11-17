/**
 * Triage orchestration: fetch failed runs, pull failed job logs,
 * extract signatures, cluster by root cause, classify, and rank.
 *
 * One triage is a bounded set of API calls: one runs list, one jobs
 * list per failed run examined, one log download per failed job
 * (capped at maxJobsPerRun per run), plus one compare per real
 * regression whose window has both endpoints (last green and first
 * red). One exception: a log download refused with 403 stops the
 * rest — the refusal applies to every job in the triage, so the
 * remaining failed jobs are recorded with the same reason without
 * another request. Unauthenticated that is about 8 calls for a
 * --runs 3 triage — inside the 60/hour limit, but the CLI still
 * says so when the limit is hit.
 */
import { ApiError, UsageError } from './errors.mjs';
import { classifyCluster, detectFlaky, findRegressionWindow } from './classify.mjs';
import { ghCompare, ghJobLog, ghJson, parseRepo, resolveToken } from './github.mjs';
import { isKnown, knownNotSeen } from './known.mjs';
import { clusterFailures, extractSignature } from './signature.mjs';

export const DEFAULT_RUNS = 10;
export const MAX_RUNS = 30;
export const MAX_JOBS_PER_RUN = 3;

function isFailure(conclusion) {
  return conclusion === 'failure' || conclusion === 'timed_out';
}

/**
 * Triage a repo's recent CI. Returns a result object ready for the
 * text or JSON reporters:
 *
 *   { repo, owner, workflow, branch, window: { runsListed, failedRuns },
 *     failures: [...], clusters: [...], fetchedAt, authenticated, rateLimit }
 *
 * Each cluster: { id, headline, category, categoryReason, flaky,
 * flakyReason, known, count, firstSeen, lastSeen, runs: [{ number, id, job,
 * url, createdAt, headSha }], evidence, location, regressionWindow } —
 * location is { file, line } when the log names the failing file,
 * else null; regressionWindow is git bisect's range as { lastGreen,
 * firstRed } (each { number, headSha, createdAt }, lastGreen null
 * when no passing run precedes the first failure in this window),
 * or null when the cluster is flaky or names no head SHA. When both
 * endpoints exist the window also carries `changedFiles`
 * ({ files, totalFiles, compareUrl }) — the filenames that changed
 * between the last green commit and the first red one, capped at 10
 * with the count of the rest, from GitHub's compare endpoint — so
 * the report names the suspect files, not just the suspect commits.
 * A compare that fails leaves changedFiles null and records the
 * reason in changedFilesError; the window itself is unchanged.
 * `known` is true when the cluster's signature is recorded in the
 * known-failures file passed as options.known (Playwright's
 * test.fail(): a failure the team already knows about and is living
 * with — it is ranked with the rest but does not count as a new
 * regression). The result also carries `knownFailures` (null when no
 * known file was given): { file, loaded, entries, notSeen } — notSeen
 * lists recorded signatures that did not appear in this window, so a
 * fixed known failure is noticed instead of silently dropping out
 * of the file's memory.
 *
 * onProgress(step) is called with a short human-readable line so the
 * CLI can show what it is doing while the API calls run.
 */
export async function triageRepo(input, options = {}) {
  const { owner, repo } = parseRepo(input);
  const runsWanted = options.runs ?? DEFAULT_RUNS;
  if (!Number.isInteger(runsWanted) || runsWanted < 1 || runsWanted > MAX_RUNS) {
    throw new UsageError(`--runs needs an integer between 1 and ${MAX_RUNS}`);
  }
  const token = options.token ?? resolveToken();
  const maxJobsPerRun = options.maxJobsPerRun ?? MAX_JOBS_PER_RUN;
  const onProgress = options.onProgress || (() => {});

  // The runs list is the history too: the newest 30 completed runs
  // of this workflow and branch, successes included, so flaky
  // detection can see whether the workflow usually passes.
  const query = new URLSearchParams({ status: 'completed', per_page: '30' });
  if (options.branch) query.set('branch', options.branch);
  const runsPath = options.workflow
    ? `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(options.workflow)}/runs?${query}`
    : `/repos/${owner}/${repo}/actions/runs?${query}`;
  onProgress(`listing recent runs for ${owner}/${repo}…`);
  const runsBody = await ghJson(runsPath, { token });
  const allRuns = (runsBody.workflow_runs || []).map((run) => ({
    id: run.id,
    number: run.run_number,
    name: run.name,
    workflow: run.workflow_id,
    branch: run.head_branch,
    headSha: run.head_sha,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    url: run.html_url,
  }));
  const history = allRuns.map(({ conclusion, headSha, createdAt, number }) => ({ conclusion, headSha, createdAt, number }));
  const failedRuns = allRuns.filter((run) => isFailure(run.conclusion)).slice(0, runsWanted);
  if (failedRuns.length === 0) {
    return {
      repo: `${owner}/${repo}`, owner, workflow: options.workflow || null, branch: options.branch || null,
      window: { runsListed: allRuns.length, failedRuns: 0 },
      failures: [], clusters: [],
      // No failures in the window: every recorded failure is a
      // "not seen" one — the repo may have fixed them all.
      knownFailures: options.knownPath
        ? {
          file: options.knownPath,
          loaded: options.known != null,
          entries: options.known ? options.known.entries.size : 0,
          notSeen: knownNotSeen([], options.known),
        }
        : null,
      fetchedAt: new Date().toISOString(),
      authenticated: token != null,
    };
  }

  const failures = [];
  // A log download refused with 403 is refused for every job in
  // this triage — GitHub does not allow anonymous log downloads,
  // and a bad token fails the same way on the next job. Dogfooding
  // on WJDdidi-1/dev-doctor unauthenticated made 30 doomed
  // downloads (21.7 s, half the 60/hour anonymous budget) before
  // reporting the token message once. So the first 403 stops the
  // downloads: the remaining failed jobs are still recorded, with
  // the same reason, without another request. Only the 403 is
  // terminal — a transient failure (network, 500) keeps the
  // per-job behaviour of recording and moving on.
  // The jobs lists are independent GETs, so they are fetched
  // concurrently: ten failed runs used to cost ~10 s of sequential
  // list calls before any log work started (a no-token triage
  // measured 10.6 s, ~10 s of it listings). The call count is
  // unchanged and bounded by MAX_RUNS (30). Only the downloads
  // below stay sequential, in run order, so the progress lines, the
  // 403 early-stop, and the failures order are exactly as before.
  const jobsByRun = await Promise.all(failedRuns.map(async (run) => {
    onProgress(`run #${run.number}: listing jobs…`);
    const jobsBody = await ghJson(`/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?per_page=100`, { token });
    return {
      run,
      failedJobs: (jobsBody.jobs || [])
        .filter((job) => isFailure(job.conclusion))
        .slice(0, maxJobsPerRun),
    };
  }));

  let logDownloadsBlocked = null;
  for (const { run, failedJobs } of jobsByRun) {
    for (const job of failedJobs) {
      const failureBase = {
        run: { id: run.id, number: run.number, headSha: run.headSha, createdAt: run.createdAt, url: run.html_url },
        job: { id: job.id, name: job.name, conclusion: job.conclusion, url: job.html_url },
      };
      if (logDownloadsBlocked) {
        failures.push({ ...failureBase, signature: null, logError: logDownloadsBlocked });
        continue;
      }
      onProgress(`run #${run.number} / job ${job.name}: downloading log…`);
      let log;
      try {
        log = await ghJobLog(job.id, { owner, repo, token });
      } catch (error) {
        // One unreadable log must not sink the whole triage: record
        // the failure with no signature and keep going — unless the
        // refusal is the 403 above, which poisons every download
        // after it.
        if (error instanceof ApiError && error.status === 403) {
          logDownloadsBlocked = error.message;
          onProgress('log downloads refused (GitHub needs a token for job logs) — skipping the remaining downloads…');
        }
        failures.push({ ...failureBase, signature: null, logError: error.message });
        continue;
      }
      if (log == null) {
        failures.push({
          ...failureBase,
          signature: null, logError: 'log no longer available (GitHub keeps logs 90 days)',
        });
        continue;
      }
      const signature = extractSignature(log, { label: job.name });
      failures.push({ ...failureBase, signature });
    }
  }

  const clusters = clusterFailures(failures).map((cluster) => {
    const { category, reason } = classifyCluster(cluster);
    const { flaky, reason: flakyReason } = detectFlaky(cluster, history);
    const runs = cluster.failures.map((f) => ({
      number: f.run.number, id: f.run.id, job: f.job.name, url: f.run.url,
      createdAt: f.run.createdAt, headSha: f.run.headSha,
    }));
    const times = cluster.failures.map((f) => new Date(f.run.createdAt).getTime());
    return {
      id: cluster.id,
      headline: cluster.headline,
      evidence: cluster.evidence,
      location: cluster.location || null,
      category, categoryReason: reason,
      flaky, flakyReason,
      known: isKnown(cluster, options.known),
      count: cluster.failures.length,
      firstSeen: new Date(Math.min(...times)).toISOString(),
      lastSeen: new Date(Math.max(...times)).toISOString(),
      runs,
      regressionWindow: findRegressionWindow({ flaky, runs }, history),
    };
  });
  // Delta's method: put the diff next to the diagnosis. For each
  // real regression whose window has both endpoints, one compare
  // call lists the files that changed between the last green commit
  // and the first red one — the suspect files, not just the suspect
  // commits. A failed compare degrades to today's window (no new
  // failure mode): the reason rides along in the JSON and a line
  // goes to stderr, and the triage still succeeds.
  for (const cluster of clusters) {
    const window = cluster.regressionWindow;
    if (!window || !window.lastGreen) continue;
    onProgress(`run #${window.firstRed.number}: listing files changed since #${window.lastGreen.number}…`);
    try {
      window.changedFiles = await ghCompare(owner, repo, window.lastGreen.headSha, window.firstRed.headSha, { token });
    } catch (error) {
      window.changedFiles = null;
      window.changedFilesError = error.message;
      onProgress(`run #${window.firstRed.number}: could not list changed files (${error.message})`);
    }
  }
  // Rank: most failures first, then most recent.
  clusters.sort((a, b) => b.count - a.count || new Date(b.lastSeen) - new Date(a.lastSeen));

  // A known failure that stops appearing is Playwright's test.fail()
  // complaining in reverse: the signature was expected to fail and
  // did not, so it may be fixed — listed, not failed on.
  const knownFailures = options.knownPath
    ? {
      file: options.knownPath,
      loaded: options.known != null,
      entries: options.known ? options.known.entries.size : 0,
      notSeen: knownNotSeen(clusters, options.known),
    }
    : null;

  return {
    repo: `${owner}/${repo}`, owner, workflow: options.workflow || null, branch: options.branch || null,
    window: { runsListed: allRuns.length, failedRuns: failedRuns.length },
    failures: failures.map((f) => ({
      run: f.run.number, job: f.job.name, signature: f.signature ? f.signature.id : null,
      headline: f.signature ? f.signature.headline : null, logError: f.logError || null,
      // The run's date rides along: the UNKNOWN report names when the
      // failed jobs ran, and a --json consumer can do the same. It
      // was dropped here once, and the span line silently vanished —
      // the report tests now pin the public shape, not the internal one.
      createdAt: f.run.createdAt,
    })),
    clusters,
    knownFailures,
    fetchedAt: new Date().toISOString(),
    authenticated: token != null,
  };
}

/**
 * Triage a pasted log (no network): one failure, one signature, one
 * classification. Used by the MCP `triage_log` tool and the tests.
 */
export function triageLogText(logText, { label = '' } = {}) {
  const signature = extractSignature(logText, { label });
  if (!signature) return { signature: null, category: 'unknown', categoryReason: 'empty log', flaky: false, flakyReason: '' };
  const cluster = { headline: signature.headline, evidence: signature.evidence, failures: [{ run: { createdAt: new Date().toISOString() } }] };
  const { category, reason } = classifyCluster(cluster);
  return { signature, category, categoryReason: reason, flaky: false, flakyReason: 'needs run history — a single log cannot say whether it is flaky' };
}

export { ApiError, UsageError };
