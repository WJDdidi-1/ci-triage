/**
 * Triage orchestration: fetch failed runs, pull failed job logs,
 * extract signatures, cluster by root cause, classify, and rank.
 *
 * One triage is a bounded set of API calls: one runs list, one jobs
 * list per failed run examined, one log download per failed job
 * (capped at maxJobsPerRun per run). Unauthenticated that is about
 * 7 calls for a --runs 3 triage — inside the 60/hour limit, but the
 * CLI still says so when the limit is hit.
 */
import { ApiError, UsageError } from './errors.mjs';
import { classifyCluster, detectFlaky } from './classify.mjs';
import { ghJobLog, ghJson, parseRepo, resolveToken } from './github.mjs';
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
 * flakyReason, count, firstSeen, lastSeen, runs: [{ number, id, job,
 * url, createdAt, headSha }], evidence, location } — location is
 * { file, line } when the log names the failing file, else null.
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
  const history = allRuns.map(({ conclusion, headSha, createdAt }) => ({ conclusion, headSha, createdAt }));
  const failedRuns = allRuns.filter((run) => isFailure(run.conclusion)).slice(0, runsWanted);
  if (failedRuns.length === 0) {
    return {
      repo: `${owner}/${repo}`, owner, workflow: options.workflow || null, branch: options.branch || null,
      window: { runsListed: allRuns.length, failedRuns: 0 },
      failures: [], clusters: [], fetchedAt: new Date().toISOString(),
      authenticated: token != null,
    };
  }

  const failures = [];
  for (const run of failedRuns) {
    onProgress(`run #${run.number}: listing jobs…`);
    const jobsBody = await ghJson(`/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?per_page=100`, { token });
    const failedJobs = (jobsBody.jobs || [])
      .filter((job) => isFailure(job.conclusion))
      .slice(0, maxJobsPerRun);
    for (const job of failedJobs) {
      onProgress(`run #${run.number} / job ${job.name}: downloading log…`);
      let log;
      try {
        log = await ghJobLog(job.id, { owner, repo, token });
      } catch (error) {
        // One unreadable log must not sink the whole triage: record
        // the failure with no signature and keep going.
        failures.push({
          run: { id: run.id, number: run.number, headSha: run.headSha, createdAt: run.createdAt, url: run.html_url },
          job: { id: job.id, name: job.name, conclusion: job.conclusion, url: job.html_url },
          signature: null, logError: error.message,
        });
        continue;
      }
      if (log == null) {
        failures.push({
          run: { id: run.id, number: run.number, headSha: run.headSha, createdAt: run.createdAt, url: run.html_url },
          job: { id: job.id, name: job.name, conclusion: job.conclusion, url: job.html_url },
          signature: null, logError: 'log no longer available (GitHub keeps logs 90 days)',
        });
        continue;
      }
      const signature = extractSignature(log, { label: job.name });
      failures.push({
        run: { id: run.id, number: run.number, headSha: run.headSha, createdAt: run.createdAt, url: run.html_url },
        job: { id: job.id, name: job.name, conclusion: job.conclusion, url: job.html_url },
        signature,
      });
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
      count: cluster.failures.length,
      firstSeen: new Date(Math.min(...times)).toISOString(),
      lastSeen: new Date(Math.max(...times)).toISOString(),
      runs,
    };
  });
  // Rank: most failures first, then most recent.
  clusters.sort((a, b) => b.count - a.count || new Date(b.lastSeen) - new Date(a.lastSeen));

  return {
    repo: `${owner}/${repo}`, owner, workflow: options.workflow || null, branch: options.branch || null,
    window: { runsListed: allRuns.length, failedRuns: failedRuns.length },
    failures: failures.map((f) => ({
      run: f.run.number, job: f.job.name, signature: f.signature ? f.signature.id : null,
      headline: f.signature ? f.signature.headline : null, logError: f.logError || null,
    })),
    clusters,
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
