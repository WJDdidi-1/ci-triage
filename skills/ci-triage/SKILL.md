---
name: ci-triage
description: Triage red CI before reading any log — group recent failed GitHub Actions runs by root cause, separate real regressions from flaky failures, and point at the evidence. Run when CI goes red, after a release ships on a red main, or when a maintainer asks "what's broken".
---

# ci-triage

Run this before reading a CI log. It answers "what's broken, what matters, what's flaky" for the whole repo in one page.

## When to use it

- CI goes red and nobody knows which failures matter.
- A release shipped while main was red and the failures need sorting out.
- The same failure keeps coming back and nobody can tell whether it is a real regression or a flaky test.

## Run it

```sh
ci-triage owner/repo
```

If the command is not installed, use `npx ci-triage-cli` instead. `--runs N` examines more failed runs (default 10, max 30); `--workflow <name>` and `--branch <name>` narrow it; `--json` gives machine-readable output. Auth: set `GH_TOKEN` for 5,000 requests/hour — GitHub does not allow anonymous job-log downloads, so without a token the triage can list the failed runs and jobs but cannot read their logs.

## Read the report

- **Clusters are ranked**: the top root cause is the one breaking the most runs. Fix that one first.
- **real regression** — the signature fails on every recent run. The code (or the environment the code assumes) is broken; fix the cause, not the test.
- **FLAKY** — the same signature fails intermittently while the workflow passes in between, or the same commit passed on retry. Do not "fix" the code for a flaky failure; quarantine the test or fix the environment, then watch the next runs.
- **category** — test, build, infra, or unknown. Unknown means the error lines said nothing recognisable; read the evidence lines before deciding.
- **evidence** — the raw log lines behind the verdict, so the classification can be checked without re-downloading the log.

## Examples

Real runs against the test suite's fixture logs (a Jest failure and
a TypeScript error, two failed runs each), so the lines are
reproducible:

**1. One flaky failure — do not fix the code.**

```sh
$ ci-triage owner/repo
Window: 3 recent runs listed, 2 failed examined
Root causes: 1 (0 real, 1 flaky)

#1  test · 2 runs · FLAKY
    FAIL src/components/Button.test.tsx
    3 test-runner failure signals in the error lines. fails intermittently while the same workflow passes in between.
    ...
Overall: 1 root cause — 0 real regressions, 1 flaky
```

Next step: quarantine the test or fix the environment, then watch the
next runs — the same failure passing in between is what makes it flaky.

**2. One real regression — fix the code.**

```sh
$ ci-triage owner/repo
Window: 2 recent runs listed, 2 failed examined
Root causes: 1 (1 real, 0 flaky)

#1  build · 2 runs · real regression
    src/utils/format.ts:18:7 - error TS2322: Type 'string' is not assignable to type 'number'.
    ...
Overall: 1 root cause — 1 real regression, 0 flaky
```

Next step: fix the type error at `src/utils/format.ts:18` — the same
error fails on every recent run, so the code (or the environment it
assumes) is broken.

## Rules

- Never read a raw job log before running ci-triage: the real cause is usually not the last line, and the report already extracts it.
- Act on the top cluster first — fixing the top cause clears the most runs, and the next triage re-ranks what is left; a repo with three root causes is fixed one cluster at a time.
- A flaky verdict is a history verdict, not a log verdict — it needs runs on both sides of the failure to be true.
