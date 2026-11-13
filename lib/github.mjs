/**
 * Minimal GitHub Actions API client — standard library only.
 *
 * Endpoints used (all read-only):
 *   GET /repos/{owner}/{repo}/actions/runs
 *   GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs
 *   GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs
 *   GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs
 *
 * Auth: GH_TOKEN or GITHUB_TOKEN when set, else `gh auth token` when
 * the gh CLI is logged in. The runs and jobs lists work
 * unauthenticated (60 requests/hour), but GitHub does not allow
 * anonymous job-log downloads — without a token the triage can list
 * the failed runs and jobs but cannot read their logs, so it reports
 * that plainly instead of pretending to triage. The API base is
 * overridable with CI_TRIAGE_API_BASE so the test suite can point
 * the client at a local mock server instead of the network.
 */
import { execFileSync } from 'node:child_process';
import { ApiError } from './errors.mjs';

export const DEFAULT_API_BASE = 'https://api.github.com';

/** API base for this run (test override, otherwise api.github.com). */
export function apiBase() {
  return (process.env.CI_TRIAGE_API_BASE || DEFAULT_API_BASE).replace(/\/$/, '');
}

/**
 * Resolve a token: GH_TOKEN, then GITHUB_TOKEN, then `gh auth token`
 * (silent when gh is missing or not logged in). Returns null when
 * nothing is available — the caller proceeds unauthenticated.
 */
export function resolveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const out = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const token = out.trim();
    return token === '' ? null : token;
  } catch {
    return null;
  }
}

/**
 * One GitHub API call. Returns the parsed JSON body. Throws ApiError
 * on HTTP failure with a message that says what went wrong in plain
 * terms (not found, bad token, rate limit, server error).
 */
export async function ghJson(path, { token = null } = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'user-agent': 'ci-triage',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${apiBase()}${path}`, { headers });
  } catch (error) {
    throw new ApiError(`could not reach the GitHub API (${error.message}) — check your network and try again`);
  }
  if (res.status === 401) {
    throw new ApiError('GitHub rejected the token (401) — check GH_TOKEN or run `gh auth login` again', 401);
  }
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0);
      const when = reset ? new Date(reset * 1000).toLocaleTimeString() : 'unknown';
      throw new ApiError(
        `GitHub API rate limit reached (403) — the limit resets around ${when}. Set GH_TOKEN for 5,000 requests/hour instead of 60, or wait and retry.`,
        403,
      );
    }
    throw new ApiError('GitHub refused the request (403) — the token may lack access to this repo', 403);
  }
  if (res.status === 404) {
    throw new ApiError('repository or workflow not found (404) — check the owner/repo spelling and that the repo is public or your token can see it', 404);
  }
  if (!res.ok) {
    throw new ApiError(`GitHub API returned ${res.status} for ${path}`, res.status);
  }
  return res.json();
}

/**
 * Fetch a job log. The endpoint answers with a redirect to a
 * temporary download URL; fetch follows it. Logs are capped (default
 * 2 MB): a failed job's log can run to tens of megabytes, and only
 * the error region is ever read. Returns the (possibly truncated)
 * log text.
 */
export async function ghJobLog(jobId, { owner, repo, token = null, maxBytes = 2_000_000 } = {}) {
  const headers = { accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'user-agent': 'ci-triage' };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${apiBase()}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, { headers });
  } catch (error) {
    throw new ApiError(`could not download the log for job ${jobId} (${error.message})`);
  }
  if (res.status === 404) return null; // log expired or never uploaded (GitHub keeps logs 90 days)
  if (res.status === 403) {
    // GitHub does not allow anonymous log downloads, even for public
    // repos — the runs and jobs lists work unauthenticated, the logs
    // do not. Say so plainly instead of a bare status code.
    throw new ApiError('downloading this job log needs a GitHub token (403) — GitHub does not allow anonymous log downloads; set GH_TOKEN or run `gh auth login`', 403);
  }
  if (!res.ok) throw new ApiError(`GitHub API returned ${res.status} for the log of job ${jobId}`, res.status);
  const text = await res.text();
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}

/** Parse `owner/repo` (or a github.com URL) into { owner, repo }. */
export function parseRepo(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('a repository is required: owner/repo');
  }
  const trimmed = input.trim().replace(/\.git$/, '');
  const urlMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };
  const parts = trimmed.split('/');
  if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
    return { owner: parts[0], repo: parts[1] };
  }
  throw new Error(`cannot parse repository "${input}" — use owner/repo or a github.com URL`);
}
