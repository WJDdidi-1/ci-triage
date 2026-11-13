/**
 * Agent Skills generation: `ci-triage --skill-generate`.
 *
 * Writes a Claude Agent Skills SKILL.md that tells an agent to run
 * ci-triage when CI goes red, read the ranked report, and act on the
 * top root cause instead of reading raw logs. Default scope is
 * --project (./.claude/skills/ci-triage/SKILL.md); --global writes
 * ~/.claude/skills/ci-triage/SKILL.md instead.
 *
 * Never overwrites: if the SKILL.md already exists, generation stops
 * with a plain message and the caller exits 1 — the file may hold the
 * user's own edits.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveHome } from './home.mjs';

export const SKILL_DIR_NAME = 'ci-triage';

export const SKILL_MD = `---
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

\`\`\`sh
ci-triage owner/repo
\`\`\`

If the command is not installed, use \`npx ci-triage-cli\` instead. \`--runs N\` examines more failed runs (default 10, max 30); \`--workflow <name>\` and \`--branch <name>\` narrow it; \`--json\` gives machine-readable output. Auth: set \`GH_TOKEN\` for 5,000 requests/hour — GitHub does not allow anonymous job-log downloads, so without a token the triage can list the failed runs and jobs but cannot read their logs.

## Read the report

- **Clusters are ranked**: the top root cause is the one breaking the most runs. Fix that one first.
- **real regression** — the signature fails on every recent run. The code (or the environment the code assumes) is broken; fix the cause, not the test.
- **FLAKY** — the same signature fails intermittently while the workflow passes in between, or the same commit passed on retry. Do not "fix" the code for a flaky failure; quarantine the test or fix the environment, then watch the next runs.
- **category** — test, build, infra, or unknown. Unknown means the error lines said nothing recognisable; read the evidence lines before deciding.
- **evidence** — the raw log lines behind the verdict, so the classification can be checked without re-downloading the log.

## Rules

- Never read a raw job log before running ci-triage: the real cause is usually not the last line, and the report already extracts it.
- Act on the top cluster first; a repo with three root causes is fixed one cluster at a time.
- A flaky verdict is a history verdict, not a log verdict — it needs runs on both sides of the failure to be true.
`;

export function skillPath(scope = 'project', base = process.cwd()) {
  if (scope === 'global') {
    return path.join(resolveHome(), '.claude', 'skills', SKILL_DIR_NAME, 'SKILL.md');
  }
  return path.join(path.resolve(base), '.claude', 'skills', SKILL_DIR_NAME, 'SKILL.md');
}

/**
 * Write the SKILL.md. Returns `{ path, created: true }` on success,
 * or `{ path, created: false, reason }` when the file already exists —
 * the caller prints the reason and exits 1.
 */
export function generateSkill(scope = 'project', base = process.cwd()) {
  const target = skillPath(scope, base);
  if (fs.existsSync(target)) {
    return { path: target, created: false, reason: `already exists: ${target}` };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, SKILL_MD);
  return { path: target, created: true };
}
