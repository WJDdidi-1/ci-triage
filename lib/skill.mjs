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
 *
 * In --project scope it also appends a short section to the repo-root
 * AGENTS.md: coding agents read AGENTS.md by default at startup,
 * while SKILL.md only helps once the agent already discovers the
 * skill, so the section is the discovery entry point. Append-only and
 * idempotent — an existing AGENTS.md is never rewritten and a second
 * run adds nothing. --global has no repo to attach it to, so it skips
 * AGENTS.md.
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

## Examples

Real runs against the test suite's fixture logs (a Jest failure and
a TypeScript error, two failed runs each), so the lines are
reproducible:

**1. One flaky failure — do not fix the code.**

\`\`\`sh
$ ci-triage owner/repo
Window: 3 recent runs listed, 2 failed examined
Root causes: 1 (0 real, 1 flaky)

#1  test · 2 runs · FLAKY
    FAIL src/components/Button.test.tsx
    3 test-runner failure signals in the error lines. fails intermittently while the same workflow passes in between.
    ...
Overall: 1 root cause — 0 real regressions, 1 flaky
\`\`\`

Next step: quarantine the test or fix the environment, then watch the
next runs — the same failure passing in between is what makes it flaky.

**2. One real regression — fix the code.**

\`\`\`sh
$ ci-triage owner/repo
Window: 2 recent runs listed, 2 failed examined
Root causes: 1 (1 real, 0 flaky)

#1  build · 2 runs · real regression
    src/utils/format.ts:18:7 - error TS2322: Type 'string' is not assignable to type 'number'.
    ...
Overall: 1 root cause — 1 real regression, 0 flaky
\`\`\`

Next step: fix the type error at \`src/utils/format.ts:18\` — the same
error fails on every recent run, so the code (or the environment it
assumes) is broken.

## Rules

- Never read a raw job log before running ci-triage: the real cause is usually not the last line, and the report already extracts it.
- Act on the top cluster first — fixing the top cause clears the most runs, and the next triage re-ranks what is left; a repo with three root causes is fixed one cluster at a time.
- A flaky verdict is a history verdict, not a log verdict — it needs runs on both sides of the failure to be true.
`;

// Frontmatter keys the Agent Skills spec allows. Anything else is a
// typo the agent will silently ignore — or a key from another tool.
const SKILL_FRONTMATTER_KEYS = new Set([
  'name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools',
]);

// name: 1-64 chars, lowercase letters/digits/single hyphens, no
// leading/trailing/double hyphen — the spec's kebab-case rule.
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validate a SKILL.md against the Agent Skills spec
 * (agentskills.io/specification), as far as a dependency-free parser
 * can: frontmatter present and closed, only known keys, name
 * kebab-case and matching the skill directory, description 1-1024
 * chars with no angle brackets, compatibility at most 500 chars, and
 * a non-empty body. Returns `{ valid: true }`, or
 * `{ valid: false, problems: [...] }` with every problem found, so
 * the caller can name the first one and count the rest.
 *
 * Why this exists: a SKILL.md with a broken frontmatter (name that
 * does not match its directory, a description over the limit) is
 * silently never triggered — the agent gives no error, the user just
 * never sees the tool run. `doctor` calls this so the breakage is
 * visible instead of silent. Multi-line values are joined with a
 * space for the length checks; `metadata` block contents are not
 * deep-validated — a full YAML parser is out of scope for this check.
 */
export function validateSkillMd(text, dirName) {
  const problems = [];
  // A skill file checked out on Windows carries CRLF; strip the \r
  // so a valid skill is not rejected for its line endings.
  const lines = String(text).split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines[0] !== '---') {
    problems.push('missing frontmatter: file must start with ---');
    return { valid: false, problems };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) {
    problems.push('frontmatter never closes: missing closing ---');
    return { valid: false, problems };
  }
  const fields = {};
  let current = null;
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (/^\s/.test(line)) {
      if (current === null) {
        problems.push(`frontmatter line ${i + 1} is indented with no key above it`);
      } else {
        // Continuation of the previous value (YAML multi-line or a
        // metadata block); joined for the length checks below.
        fields[current] += ` ${line.trim()}`;
      }
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):(?:[ \t](.*))?$/);
    if (!match) {
      problems.push(`frontmatter line ${i + 1} is not "key: value"`);
      current = null;
      continue;
    }
    current = match[1];
    if (current in fields) problems.push(`duplicate frontmatter key "${current}"`);
    fields[current] = match[2] ?? '';
  }
  for (const key of Object.keys(fields)) {
    if (!SKILL_FRONTMATTER_KEYS.has(key)) problems.push(`unknown frontmatter key "${key}"`);
  }
  if (!('name' in fields)) {
    problems.push('frontmatter is missing "name"');
  } else {
    const name = fields.name;
    if (name.length < 1 || name.length > 64) problems.push(`name must be 1-64 characters (is ${name.length})`);
    if (!SKILL_NAME_RE.test(name)) problems.push(`name "${name}" must be lowercase letters, digits and single hyphens (no leading, trailing or double hyphen)`);
    if (dirName && name !== dirName) problems.push(`name "${name}" does not match the skill directory "${dirName}"`);
  }
  if (!('description' in fields)) {
    problems.push('frontmatter is missing "description"');
  } else {
    const description = fields.description;
    if (description.length < 1 || description.length > 1024) problems.push(`description must be 1-1024 characters (is ${description.length})`);
    if (/[<>]/.test(description)) problems.push('description must not contain < or >');
  }
  if ('compatibility' in fields && fields.compatibility.length > 500) {
    problems.push(`compatibility must be at most 500 characters (is ${fields.compatibility.length})`);
  }
  if ('license' in fields && fields.license.trim() === '') problems.push('license must not be empty');
  if ('allowed-tools' in fields && fields['allowed-tools'].trim() === '') problems.push('allowed-tools must not be empty');
  const body = lines.slice(close + 1).join('\n').trim();
  if (!body) problems.push('SKILL.md has no body after the frontmatter');
  return problems.length ? { valid: false, problems } : { valid: true };
}

export function skillPath(scope = 'project', base = process.cwd()) {
  if (scope === 'global') {
    return path.join(resolveHome(), '.claude', 'skills', SKILL_DIR_NAME, 'SKILL.md');
  }
  return path.join(path.resolve(base), '.claude', 'skills', SKILL_DIR_NAME, 'SKILL.md');
}

/**
 * The AGENTS.md section: tool name, one-line purpose, the two most-used
 * commands, repo link. The marker line is what makes the write
 * idempotent — if it is already in the file, there is nothing to add.
 */
export const AGENTS_MARKER = '<!-- ci-triage: agents-section -->';

export const AGENTS_SECTION = `${AGENTS_MARKER}
## ci-triage

When CI goes red, run \`ci-triage <owner/repo>\` (or \`npx ci-triage-cli <owner/repo>\`) before reading any log: it groups the recent failed runs by root cause and separates real regressions from flaky failures. Act on the top cluster first; \`ci-triage <owner/repo> --json\` gives the same report as JSON. Full skill: \`.claude/skills/ci-triage/SKILL.md\`. Repo: https://github.com/WJDdidi-1/ci-triage
`;

/**
 * Append the AGENTS.md section to the repo root. Returns
 * `{ path, status }` with status 'created' (no file existed),
 * 'appended' (added to an existing file, content untouched),
 * 'already-present' (marker found, no-op), or 'skipped' (--global:
 * AGENTS.md belongs to a repo, and --global has no repo).
 */
export function ensureAgentsSection(scope = 'project', base = process.cwd()) {
  if (scope === 'global') {
    return { path: null, status: 'skipped', reason: '--global has no repo: AGENTS.md belongs to a repo, run --skill-generate in the repo instead' };
  }
  const target = path.join(path.resolve(base), 'AGENTS.md');
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, 'utf8');
    if (existing.includes(AGENTS_MARKER)) {
      return { path: target, status: 'already-present' };
    }
    const join = existing.length === 0 ? '' : (existing.endsWith('\n') ? '\n' : '\n\n');
    fs.appendFileSync(target, `${join}${AGENTS_SECTION}`);
    return { path: target, status: 'appended' };
  }
  fs.writeFileSync(target, AGENTS_SECTION);
  return { path: target, status: 'created' };
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
