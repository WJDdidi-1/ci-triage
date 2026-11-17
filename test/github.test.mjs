import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { ApiError } from '../lib/errors.mjs';
import { ghJobLog, ghJson } from '../lib/github.mjs';

// The API client's error branches, tested on their own: coverage
// (vitest's method, measured with Node's built-in
// --experimental-test-coverage) showed lib/github.mjs at 88.48%
// lines with every ghJson error branch uncovered — the 401, the two
// 403s, the 404 and the generic failure are the exact messages a user
// sees when the API refuses them, and nothing verified them. The
// scenario mock server always answers 200 for the runs list, so these
// tests use a tiny status server instead.

// A server that answers every request with one status, headers, body.
function startStatusServer(status, { headers = {}, body = '{}' } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// Run fn with the API base pointed at `base`, restoring it after.
async function withBase(base, fn) {
  const prev = process.env.CI_TRIAGE_API_BASE;
  process.env.CI_TRIAGE_API_BASE = base;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.CI_TRIAGE_API_BASE;
    else process.env.CI_TRIAGE_API_BASE = prev;
  }
}

async function expectApiError(promise, status, pattern) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${error}`);
    assert.equal(error.status, status);
    assert.match(error.message, pattern);
    return true;
  });
}

test('ghJson: 401 names the rejected token', async () => {
  const server = await startStatusServer(401);
  try {
    await withBase(server.base, () =>
      expectApiError(ghJson('/repos/o/r/actions/runs'), 401, /rejected the token/));
  } finally {
    await server.close();
  }
});

test('ghJson: 403 with an exhausted budget names the rate limit and its reset', async () => {
  const server = await startStatusServer(403, {
    headers: {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    },
  });
  try {
    await withBase(server.base, () =>
      expectApiError(ghJson('/repos/o/r/actions/runs'), 403, /rate limit reached/));
  } finally {
    await server.close();
  }
});

test('ghJson: 403 with budget left names the refusal, not the rate limit', async () => {
  const server = await startStatusServer(403, {
    headers: { 'x-ratelimit-remaining': '59' },
  });
  try {
    await withBase(server.base, () =>
      expectApiError(ghJson('/repos/o/r/actions/runs'), 403, /refused the request/));
  } finally {
    await server.close();
  }
});

test('ghJson: 404 names the missing repo', async () => {
  const server = await startStatusServer(404);
  try {
    await withBase(server.base, () =>
      expectApiError(ghJson('/repos/o/r/actions/runs'), 404, /not found \(404\)/));
  } finally {
    await server.close();
  }
});

test('ghJson: any other failure names the status', async () => {
  const server = await startStatusServer(500);
  try {
    await withBase(server.base, () =>
      expectApiError(ghJson('/repos/o/r/actions/runs'), 500, /returned 500/));
  } finally {
    await server.close();
  }
});

test('ghJson: an unreachable API names the network, not the status', async () => {
  // Port 1 on loopback is closed, so fetch fails instead of answering.
  await withBase('http://127.0.0.1:1', () =>
    expectApiError(ghJson('/repos/o/r/actions/runs'), null, /could not reach the GitHub API/));
});

test('ghJobLog: an unreachable API names the job it could not fetch', async () => {
  await withBase('http://127.0.0.1:1', () =>
    expectApiError(
      ghJobLog(42, { owner: 'o', repo: 'r' }),
      null,
      /could not download the log for job 42/,
    ));
});
