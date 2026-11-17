/**
 * A mock GitHub API server for the test suite, so triageRepo and
 * the CLI can be exercised end to end without the network.
 *
 * A scenario is { runs: [...], jobs: { [runId]: [...] }, logs: { [jobId]: 'text' }, compare: {...} }.
 * Runs are workflow_runs in the shape the real API returns; jobs are
 * the jobs array of a run's jobs list. `compare` is { files: [filenames], html_url }
 * (or a status code to answer with) for the compare endpoint. The server
 * answers the four endpoints triageRepo uses and 404s everything else.
 */
import http from 'node:http';

export function startMockServer(scenario) {
  // Every request pathname, in order — so a test can prove how many
  // calls a triage made (for example, that a refused log download
  // stops the rest instead of retrying a request known to fail).
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(url.pathname);
    const runsMatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/actions\/runs$/);
    const workflowRunsMatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+\/runs$/);
    const jobsMatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs$/);
    const logsMatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/actions\/jobs\/(\d+)\/logs$/);
    const compareMatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/compare\/.+$/);
    if (runsMatch || workflowRunsMatch) {
      const runs = scenario.runs || [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
      return;
    }
    if (jobsMatch) {
      const jobs = (scenario.jobs || {})[jobsMatch[1]] || [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ total_count: jobs.length, jobs }));
      return;
    }
    if (logsMatch) {
      const log = (scenario.logs || {})[logsMatch[1]];
      if (log == null) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }
      // A numeric log value is a status code to answer with (the
      // tests use 403 to stand in for GitHub's anonymous-download
      // refusal).
      if (typeof log === 'number') {
        res.writeHead(log, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Forbidden' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(log);
      return;
    }
    if (compareMatch) {
      const compare = scenario.compare;
      if (compare == null) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }
      // A numeric compare value is a status code to answer with (the
      // tests use 404 to stand in for "no common ancestor").
      if (typeof compare === 'number') {
        res.writeHead(compare, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        html_url: compare.html_url ?? 'https://github.com/o/r/compare/ccc0000...aaa0000',
        files: (compare.files || []).map((filename) => ({ filename })),
        total_commits: compare.totalCommits ?? 1,
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not Found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** One workflow run in the shape the real API returns. */
export function run(id, overrides = {}) {
  return {
    id,
    run_number: overrides.number ?? id,
    name: overrides.name ?? 'CI',
    workflow_id: overrides.workflow_id ?? 1,
    head_branch: overrides.branch ?? 'main',
    head_sha: overrides.headSha ?? `abc${id}def0000000000000000000000000000000`,
    conclusion: overrides.conclusion ?? 'failure',
    created_at: overrides.createdAt ?? '2026-11-12T14:03:15Z',
    html_url: `https://github.com/o/r/actions/runs/${id}`,
    ...overrides.extra,
  };
}

/** One job in the shape the real API returns. */
export function job(id, overrides = {}) {
  return {
    id,
    name: overrides.name ?? 'test',
    conclusion: overrides.conclusion ?? 'failure',
    html_url: `https://github.com/o/r/actions/runs/1/jobs/${id}`,
    ...overrides.extra,
  };
}
