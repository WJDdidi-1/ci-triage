# ci-triage

CI is red. Which failure matters, and is it a real regression or just flaky?

`ci-triage` answers that in one page: it fetches a repo's recent failed GitHub Actions runs, reads the failed job logs, groups failures by root cause, and tells you which ones are real regressions and which are flaky — so you fix the one thing that matters instead of reading thousands of log lines by hand.

## Before / after

Before: CI is red on 3 runs. You open each run, find the failed job, scroll through the log, and try to remember whether you saw this error yesterday.

After:

```
$ ci-triage acme/widgets

ci-triage — acme/widgets
Window: 2 recent runs listed, 2 failed examined
Root causes: 1 (1 real, 0 flaky)

#1  test · 2 runs · real regression
    FAIL src/components/Button.test.tsx
    3 test-runner failure signals in the error lines. fails on every recent run — looks like a real regression, not flakiness.
    first seen 2026-11-12 10:00 · last seen 2026-11-12 14:03
    runs: #2 (test), #1 (test)
    evidence:
      FAIL src/components/Button.test.tsx
      ● Button › renders the disabled state
      expect(received).toBe(expected) // Object.is equality

Overall: 1 root cause — 1 real regression, 0 flaky
```

One root cause, two runs, real regression, with the failing test named. That is the whole triage.

## Install

```sh
npm install -g ci-triage-cli
```

Requires Node 18 or newer. No other dependencies — pure Node.js standard library.

## Use

```sh
ci-triage <owner/repo>            # triage the last 10 failed runs
ci-triage acme/widgets --runs 3   # fewer runs, faster
ci-triage acme/widgets --workflow ci.yml --branch main
ci-triage acme/widgets --json     # machine-readable output
ci-triage acme/widgets --top 3    # show only the top 3 root causes
```

Exit codes: `0` when no failed job turned up, `1` when failures were found (including failures whose logs could not be read — the repo is not clean), `2` for a usage error or an API error.

## Auth — read this first

Set `GH_TOKEN` (or `GITHUB_TOKEN`). Without a token the triage can list the failed runs and jobs, **but it cannot download their logs**: GitHub does not allow anonymous job-log downloads, even for public repos. Without a token you get an honest report instead of a triage:

```
No clusters: 9 failed jobs found, but their logs could not be read.
Reason: downloading this job log needs a GitHub token (403) — GitHub does not allow anonymous log downloads; set GH_TOKEN or run `gh auth login`
Overall: UNKNOWN — 9 failed jobs found, logs unreadable
```

With a token you get 5,000 API requests per hour. `gh auth login` works too when the GitHub CLI is logged in.

## How it decides

- **Signature:** the error lines of a failed job, with timestamps, ANSI codes, file paths, hashes, versions and counts stripped — so the same failure on two runs has the same signature even when the paths and timings differ.
- **Clustering:** failures with the same signature are one root cause, ranked by how many runs they hit.
- **Classification:** each cluster is a test failure, a build failure, or an infra failure (timeouts and the like), from the error lines themselves.
- **Flaky vs real:** a cluster is flaky when the same commit passed on a later run, or when failures and successes alternate in the window. Failing on every recent run is a real regression.

Logs expire: GitHub keeps job logs for 90 days. A failed job whose log is gone is recorded, not fatal.

## For agents

```sh
ci-triage --mcp               # stdio MCP server: triage_repo, triage_log
ci-triage --skill-generate    # write a SKILL.md for this project (never overwrites)
```

`triage_log` classifies a pasted log without touching the network — useful when you already have the log open.

## GitHub Action

Use it from a workflow (it needs a token with `actions:read` on the repo; the workflow's own `GITHUB_TOKEN` can read its own repo's runs):

```yaml
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: WJDdidi-1/ci-triage@main
        with:
          repo: ${{ github.repository }}
          runs: 10
```

The action fails the job when it finds root causes, so the triage report lands in the log.

## How fast is it

On a real repo with 3 failed runs and 9 failed jobs, the triage took about 8 seconds wall-clock — against opening 9 job logs by hand and reading them. The clustering and classification themselves run in milliseconds; the time is the GitHub API round-trips.

## Troubleshooting

- **"needs a GitHub token (403)"** — set `GH_TOKEN`. See [Auth](#auth--read-this-first).
- **"could not reach the GitHub API"** — the API is unreachable from here (network or proxy); check connectivity and try again. The triage never reports a clean bill of health when it could not check.
- **A failed job's log is gone** — GitHub keeps logs 90 days; the job is listed with its reason and the rest of the triage goes on.
- **`npx ci-triage-cli` says "ci-triage: not found" inside this repo's own checkout** — npm resolves the local package instead of the installed one. Run it from outside the checkout, use `node bin/ci-triage.js`, or `npm link` first.

## License

Apache-2.0.
