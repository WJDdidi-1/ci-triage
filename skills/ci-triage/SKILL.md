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
- A failure the team already knows about keeps re-alerting as a real regression on every triage.

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
- **known failure** — the signature is recorded in a known-failures file (see below). The team already knows about it and is living with it; it is not a new regression, and a triage with only known failures exits 0 instead of failing the gate.
- **regression window** — a real regression names the last green run and the first red one ("broke between #1 (ccc0000) and #2 (aaa0000)"); `git log <green>..<red>` lists the suspect commits. The report also lists the files changed between those two commits (from GitHub's compare endpoint, capped at 10 with a count of the rest), so the suspect files are named, not just the suspect commits; a compare that fails leaves the window line as it was. When no passing run precedes the first failure, the report says the regression predates the runs listed; a flaky failure has no window at all, because passes and failures interleave.
- **evidence** — the raw log lines behind the verdict, so the classification can be checked without re-downloading the log.

## Known failures

A failure the team knows about and is living with should not re-alert as a real regression on every triage — it drowns the new regressions. Record it once, then triage against the record:

```sh
ci-triage owner/repo --write-known .ci-triage-known-failures.json
ci-triage owner/repo --known .ci-triage-known-failures.json
```

`--write-known` records the current clusters (signature hashes and headlines only — the file is safe to commit) and merges with entries already there; `--known` marks the clusters the file covers as known failures. Matching is by signature, so a known failure stays known when it moves to another workflow. A recorded failure that stops appearing is listed as "not seen in this window (possibly fixed)" — remove it from the file if it is fixed. The method is Playwright's `test.fail()`: a known bug that is still exercised, expected to fail, and noticed when it stops failing.

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

**3. One known failure — nothing new to fix.**

The same TypeScript error, after it was recorded with
`--write-known .ci-triage-known-failures.json`:

```sh
$ ci-triage owner/repo --known .ci-triage-known-failures.json
Window: 2 recent runs listed, 2 failed examined
Root causes: 1 (0 real, 0 flaky, 1 known)

#1  build · 2 runs · known failure
    src/utils/format.ts:18:7 - error TS2322: Type 'string' is not assignable to type 'number'.
    ...
    Recorded as a known failure — not a new regression.
Overall: KNOWN — 1 known failure, no new regressions
```

Next step: nothing — the failure is already tracked. If it stops
appearing, the next triage lists it as "not seen in this window
(possibly fixed)" so it can be removed from the file.

## Rules

- Never read a raw job log before running ci-triage: the real cause is usually not the last line, and the report already extracts it.
- Act on the top cluster first — fixing the top cause clears the most runs, and the next triage re-ranks what is left; a repo with three root causes is fixed one cluster at a time.
- A flaky verdict is a history verdict, not a log verdict — it needs runs on both sides of the failure to be true.
- Record a failure you are living with instead of ignoring the report — a known failure that keeps re-alerting as a real regression trains everyone to ignore the triage, and then a new regression hides in the noise with it.
