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

Rather not install it by hand? Paste this to your coding agent: "Install ci-triage (npm install -g ci-triage-cli if it's not on PATH), then run ci-triage --skill-generate so you triage red CI before reading any log."

## Use

```sh
ci-triage <owner/repo>            # triage the last 10 failed runs
ci-triage acme/widgets --runs 3   # fewer runs, faster
ci-triage acme/widgets --workflow ci.yml --branch main
ci-triage acme/widgets --json     # machine-readable output
ci-triage acme/widgets --top 3    # show only the top 3 root causes
ci-triage acme/widgets --report triage.md  # Markdown report to paste into a PR, an issue, or an agent chat
ci-triage acme/widgets --annotations  # also emit ::error:: / ::warning:: annotations for GitHub Actions
```

`--report` writes the same Markdown the GitHub Action puts in the Step Summary — the ranked report, not machine JSON — so the file, the summary, and the terminal output never disagree. Under `--json` the confirmation goes to stderr, so stdout stays parseable. `--annotations` does the same job for the run's annotations panel: one workflow-command line per root cause (`::error::` for a real regression, `::warning::` for flaky or unknown), capped at 10 per level — GitHub's own limit. When the log names the failing file with a line (`src/utils/format.ts:18:7`, a Jest stack frame), the annotation is pinned to that file and line, so it also shows in the PR's changed-files view, one click from the code; a bare filename, an absolute runner path, or a `node_modules` frame stays unpinned rather than pointing at the wrong file. Under `--json` the lines go to stderr, so stdout stays parseable.

Exit codes: `0` when no failed job turned up, `1` when failures were found (including failures whose logs could not be read — the repo is not clean), `2` for a usage error or an API error.

Shell completion for bash, zsh and fish: `ci-triage completion bash` prints a completion script generated from the same option list the CLI parses, so it can never suggest a flag the CLI rejects. Install it with, e.g. `ci-triage completion bash > ~/.bash_completion.d/ci-triage`, or `source <(ci-triage completion bash)` for a one-off session. Mistyped a flag anyway? The CLI suggests the closest match (`Did you mean ...?`) instead of a bare error.

## Auth — read this first

Set `GH_TOKEN` (or `GITHUB_TOKEN`). Without a token the triage can list the failed runs and jobs, **but it cannot download their logs**: GitHub does not allow anonymous job-log downloads, even for public repos. Without a token you get an honest report instead of a triage:

```
No clusters: 9 failed jobs found, but their logs could not be read.
Reason: downloading this job log needs a GitHub token (403) — GitHub does not allow anonymous log downloads; set GH_TOKEN or run `gh auth login`
Overall: UNKNOWN — 9 failed jobs found, logs unreadable
```

With a token you get 5,000 API requests per hour. `gh auth login` works too when the GitHub CLI is logged in.

`ci-triage doctor` checks the setup itself before you triage anything: Node version, `ci-triage` on PATH, the home directory `--skill-generate` writes into, installed skills (and whether their frontmatter is valid — a broken one silently never triggers), whether a token is available, and whether the GitHub API answers (one cheap call, which also reports the rate-limit budget left this hour). It is read-only — it changes nothing — and every failure comes with a copy-paste fix. Warnings are for optional wiring (a missing skill, no token, an unreachable API); only failures make it exit 1. `--json` gives the same checklist as data. The method is Claude Code's `claude doctor`: one command that answers "is my setup healthy?" instead of debugging each piece by hand.

## How it decides

- **Signature:** the error lines of a failed job, with timestamps, ANSI codes, file paths, hashes, versions and counts stripped — so the same failure on two runs has the same signature even when the paths and timings differ.
- **Clustering:** failures with the same signature are one root cause, ranked by how many runs they hit.
- **Classification:** each cluster is a test failure, a build failure, or an infra failure (timeouts and the like), from the error lines themselves.
- **Flaky vs real:** a cluster is flaky when the same commit passed on a later run, or when failures and successes alternate in the window. Failing on every recent run is a real regression.

Logs expire: GitHub keeps job logs for 90 days. A failed job whose log is gone is recorded, not fatal.

## For agents

```sh
ci-triage --mcp               # stdio MCP server: triage_repo, triage_log
ci-triage --skill-generate    # write a SKILL.md for this project (never overwrites) and a short section in AGENTS.md
```

`triage_log` classifies a pasted log without touching the network — useful when you already have the log open.

The MCP server also serves one prompt, `triage_ci` (`prompts/list` / `prompts/get`): the one-shot "what broke in CI and what do I fix first?" workflow — call `triage_repo` with the repo (and workflow, if given), report the root causes ranked real regressions first, then flaky, then unknown, and do not re-run or fix anything without the user agreeing — for MCP clients that let the user pick a prompt instead of typing a request. The method is FastMCP's: prompts are the third MCP primitive, the user-invoked template next to tools and resources.

Claude Code users can install the skill without installing the CLI first: `/plugin marketplace add WJDdidi-1/ci-triage`, then `/plugin install ci-triage@ci-triage`. The skill lives in this repo at `skills/ci-triage/SKILL.md`, so skill indexes can find it too.

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

The action fails the job when it finds root causes, so the triage report lands in the log and in the run's Step Summary. Add `--annotations` to surface each root cause on the run's annotations panel too — one `::error::` per real regression, `::warning::` for flaky or unknown — so the cause is visible without opening the log at all. It needs no token and no file, and it works on fork PRs, where the Checks API cannot write; the same trick reviewdog's `github-annotations` reporter uses. Locally it is a no-op: the lines only become annotations when a step runs in GitHub Actions.

## How fast is it

On a real repo with 3 failed runs and 9 failed jobs, the triage took about 8 seconds wall-clock — against opening 9 job logs by hand and reading them. The clustering and classification themselves run in milliseconds; the time is the GitHub API round-trips.

## Troubleshooting

- **"needs a GitHub token (403)"** — set `GH_TOKEN`. See [Auth](#auth--read-this-first).
- **"could not reach the GitHub API"** — the API is unreachable from here (network or proxy); check connectivity and try again. The triage never reports a clean bill of health when it could not check.
- **A failed job's log is gone** — GitHub keeps logs 90 days; the job is listed with its reason and the rest of the triage goes on.
- **`npx ci-triage-cli` says "ci-triage: not found" inside this repo's own checkout** — npm resolves the local package instead of the installed one. Run it from outside the checkout, use `node bin/ci-triage.js`, or `npm link` first.

## License

Apache-2.0.
