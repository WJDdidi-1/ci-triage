# Changelog

## 0.1.3 — 2026-11-17

- A flag-shaped subcommand now suggests the subcommand: `ci-triage
  --doctor` used to die with a bare "unknown option" and no hint, even
  though the user almost certainly meant the `doctor` subcommand — the
  suggester only matched against options, and `--doctor` is not one.
  Before any repo is parsed, an unknown option is now also matched
  (dashes stripped) against the subcommands, so `--doctor` suggests
  `doctor` and `--completio` suggests `completion`; an option typo
  still wins when it is closer (`--hepl` still suggests `--help`), and
  after a repo is parsed the fallback stays off, so `o/r --doctor`
  suggests nothing. Same method gh uses (Cobra's threshold 2),
  extended one step: gh suggests commands for mistyped commands, this
  also suggests them for flag-shaped ones.

- An unreadable window now names when the failed jobs ran: dogfooding
  unauthenticated on WJDdidi-1/dev-doctor showed the UNKNOWN report
  with no dates at all — 30 failed jobs, no way to tell whether they
  broke today or last week. The runs already carry their dates, so
  the report and the Step Summary now print `Failed jobs #44–#57 ·
  2026-11-14 12:03 – 2026-11-15 08:41` under the No-clusters line
  (singular for one job; absent when no failure carries a date,
  never a guess).

- `--skill-generate --agents` writes the skill to `.agents/skills/`
  instead of `.claude/skills/` — the same spec-valid SKILL.md, a
  different destination. Gemini CLI (108,873 stars, verified this
  round) discovers skills from `.agents/skills/` and
  `~/.agents/skills/` — its own docs call the alias "an
  interoperable path … compatible across different AI tools" — and
  Codex scans `.agents/skills` too, but `--skill-generate` only
  ever wrote the Claude paths, so a Gemini or Codex user got a skill
  their agent never saw. `doctor` now probes all four skill homes
  (project/global × Claude/shared) and says which one it found, and
  the AGENTS.md section points at the file that was actually
  written.

- `--help` now ends with an Examples section: the three invocations
  a first-time user actually types (plain triage, `--workflow`,
  `--report`), each with one line saying what it does. The help
  was a flag reference with no runnable example — the method is
  tldr's, examples first, flag reference second. Pinned by a test
  so the examples cannot drift from the commands they show.

- Tests: coverage is now measured with Node's built-in runner
  (vitest's `--coverage` method, no new dependency): full-suite
  line coverage 97.7% (branches 85.5%, functions 97.1%).
  Measuring it found every `ghJson` error branch untested — the
  401, both 403s, the 404 and the generic failure are now pinned
  against a local status server, so the messages a user sees when
  the API refuses them are verified instead of assumed. The one
  remaining uncovered line pair is `parseRepo`'s empty-input
  guard, which the CLI's own check makes unreachable (the
  user-facing message is covered in `cli.test.mjs`).

- Faster: the jobs lists for all failed runs are fetched concurrently
  instead of one run at a time. A no-token triage of ten failed runs
  measured 10.6 s, about 10 s of it sequential list calls before any
  log work started; the lists are independent GETs, so they now go
  out together and the same triage now takes ~2–4 s: measured live
  2026-11-17 on WJDdidi-1/dev-doctor `--runs 10` (no token, same
  condition as the 10.6 s baseline) at 4.2 s, 2.4 s and 2.9 s over
  three runs (median 2.9 s, ~3.7× faster). The call
  count is unchanged, the downloads stay sequential in run order, and
  the report is identical.

- Fix: one refused log download now stops the rest. Dogfooding
  unauthenticated on WJDdidi-1/dev-doctor made 30 log downloads —
  every one a 403, since GitHub does not allow anonymous job-log
  downloads — before reporting the token message once: 21.7 s and
  half the 60/hour anonymous budget spent on requests known to fail
  after the first. The first 403 now stops the downloads: the
  remaining failed jobs are still listed and recorded with the same
  reason, without another request, so the report is identical
  ("30 failed jobs found, but their logs could not be read") and
  the same triage now takes 10.6 s and one download attempt. Only
  the 403 is terminal — a transient failure (network, 500) still
  records the one job and moves on to the next.

- New: a one-click install for Claude Desktop — the repo now ships a
  `manifest.json` (MCPB, the renamed DXT format: modelcontextprotocol
  /mcpb, 2,178 stars) and a `.mcpbignore`, so `npx
  @anthropic-ai/mcpb pack` builds a `.mcpb` bundle the user drags
  onto Settings → Extensions. Distribution is the bottleneck, and
  Claude Desktop users previously had no install path at all: the
  marketplace is Claude Code only, and the MCP registry is a listing,
  not an installer. The bundle is just the server — zero
  dependencies, so there are no node_modules to bundle — and
  `.mcpbignore` keeps tests and tooling out (186 KB → 68 KB, 48 →
  19 files). The manifest is valid against the official v0.3 schema
  (checked offline with ajv), the bundle packs with the official
  toolchain, and an extracted dev-diagnosis bundle runs standalone
  over MCP. New tests pin the manifest against package.json (name,
  version, description, license, repository) and against the live
  server (tool and prompt names, first-sentence descriptions, the
  prompt template rendered for sample arguments), and the bump
  script now moves the manifest version with the rest. Honest limit:
  no Claude Desktop here, so the install click itself is
  unverified — the local proof is that the manifest validates, the
  bundle packs, and the bundled server answers.

- New: a real regression's window now names the files that changed
  between the last green commit and the first red one (GitHub's
  compare endpoint, one extra call per windowed cluster, capped at
  10 files with a count of the rest and a link to the full diff), so
  the report points at the suspect files, not just the suspect
  commit range. A compare that fails (no common ancestor, rate
  limit) leaves the window line as it was and records the reason in
  the JSON — the triage never fails over it. The method is delta's:
  put the diff next to the diagnosis.
- Fix: the README no longer states a test count — it said "184
  tests" while the suite was already 187, and a count in the README
  goes stale the next round that adds a test. The suite prints its
  own count on every run, so there is no number left to rot; a test
  pins the line so a count cannot creep back in.
- Fix: the CI, publish and MCP-registry workflows pinned their actions
  to mutable major-version tags (`actions/checkout@v4`,
  `actions/setup-node@v4`) and the checkout steps persisted the
  `GITHUB_TOKEN` into the workspace. A zizmor audit (7,061 stars)
  flagged all six uses at High confidence plus three
  `persist-credentials` warnings — a moved tag would run attacker
  code inside the unattended release pipeline, which publishes to npm
  with OIDC. Both actions are now pinned to the full commit SHA of
  their v4 tag (with a `# v4` comment so the version stays readable)
  and every checkout sets `persist-credentials: false`; actionlint
  and zizmor re-runs are clean of both findings. Two Low-confidence
  findings remain and are deliberate: the pack smoke test installs
  the tarball built in the same job, and no `cache:` input is set
  anywhere, so there is no package-manager cache to poison on the
  release-only workflows.

## 0.1.2 — 2026-11-15

- New: MCP structured output — both tools now declare a loose
  `outputSchema: { type: 'object' }` in `tools/list`, and a successful
  `tools/call` returns the same object as `structuredContent`
  alongside the unchanged text block, so a calling application (the
  MCP Inspector's Structured Output panel, a host that routes on
  fields) can read the result typed instead of parsing the text.
  Error results carry no `structuredContent`. The schema stays loose
  on purpose: the payloads are dynamic nested objects, and the
  Inspector validates `structuredContent` against `outputSchema`
  with AJV, so a detailed schema would warn on any property it does
  not list. The declared protocol version stays `2024-11-05`: the
  fields are additive and older clients ignore them, the same
  precedent as annotations. The method is the MCP Inspector's
  (11,297 stars) structured-output panel.
- New: regression window — a real regression now names the last
  green run and the first red one ("broke between #1 (ccc0000) and
  #2 (aaa0000) — git log ccc0000..aaa0000 lists the suspect
  commits"), in the terminal report, the Markdown report, `--json`
  and the `--annotations` message. The method is git bisect's — the
  good and bad endpoints — answered from the run history instead of
  a binary search, since CI already ran every commit's build. A
  flaky failure has no window (passes and failures interleave, so
  no single boundary exists); when no passing run precedes the
  first failure, the report says the regression predates the runs
  listed instead of pretending the window is closed.
- New: known failures — `--write-known <file>` records the current
  clusters as known failures (signature hashes and headlines only,
  merged with entries already in the file, safe to commit) and
  `--known <file>` marks the clusters it covers as known failures
  instead of new regressions, so a failure the team is living with
  stops re-alerting on every triage. A triage with only known
  failures reports `Overall: KNOWN` and exits 0; a recorded failure
  that stops appearing is listed as "not seen in this window
  (possibly fixed)". The method is Playwright's `test.fail()` — a
  known bug still exercised, expected to fail, and noticed when it
  stops failing — with the signature-fingerprint baseline shape from
  dev-diagnosis's secrets baseline. Also on the MCP `triage_repo`
  tool (`knownFile`), the `triage_ci` prompt, the skill, and shell
  completion.

- New: one-command version bumps — `node scripts/bump-version.mjs
  <version>` moves every version pin at once (package.json,
  package-lock.json, server.json, the marketplace metadata), renames
  the CHANGELOG's `## Unreleased` heading to the new version, and
  refuses a drifted tree before writing anything instead of
  half-bumping it. The method is semantic-release's (one mechanical
  writer of version strings), without adopting semantic-release
  itself. The script is shared with dev-diagnosis: files a repo does
  not have (pre-commit manifest, demo tape) are skipped.
- Fixed: the Windows CI failures the first 0.1.2 push exposed. The
  version-bump script never ran on Windows — its entry-point guard
  compared `import.meta.url` with `'file://' + process.argv[1]`, which
  never matches a drive-letter path (`C:\...`), so it exited 0 having
  done nothing; the guard now compares resolved filesystem paths.

## 0.1.1 — 2026-11-14

- Fix: the CI matrix went red on the first 0.1.1 push (0/12 jobs) and
  this release fixes all four failure modes before shipping. The zsh
  completion syntax check now skips when zsh is not installed (the
  Ubuntu and Windows runners ship none). The TTY star-prompt test
  now runs the CLI under python3's `pty.spawn` instead of `script`:
  on macOS `script` exits as soon as its stdin hits EOF, and under a
  test harness stdin is already EOF, so the child was killed before
  it printed anything. `doctor`'s bare-temp-dir test now expects the
  home check to warn on Windows, where `os.homedir()` reads the user
  profile instead of `$HOME` — the warning is the correct behaviour.
  The SKILL.md validator now accepts CRLF line endings, and
  `.gitattributes` pins `skills/*/SKILL.md` to LF so a Windows
  checkout cannot break the byte-identical marketplace test.

- New: `--annotations` now pins each root cause to the failing file
  and line (`::error file=src/utils/format.ts,line=18,title=…::…`)
  when the log names one, so the annotation also shows in the PR's
  changed-files view, one click from the code — a bare `::error::`
  only shows on the run's annotations panel. The signature extractor
  reads the location from the whole log starting at the first error
  line (a Jest stack frame sits several lines below the FAIL line,
  outside the 5-line evidence window); a cluster pins to its newest
  run's location. A bare filename (`config_test.go:88`), an absolute
  runner path, or a `node_modules` frame stays unpinned rather than
  pointing at the wrong file. 5 new tests (tsc + Jest pinning,
  the three unpinned cases, the signature location on all three
  fixture kinds) plus two updated end-to-end assertions against the
  mock GitHub API. The method is EnricoMi's
  publish-unit-test-result-action — one annotation per failing test,
  attached to its file. Honest limit: the pinned line is the newest
  run's, so if the failure moved between runs the line may be stale;
  the annotation message still names every run.
- New: the MCP server now serves a prompt, `triage_ci`
  (`prompts/list` / `prompts/get`, advertised in `initialize`): the
  one-shot "what broke in CI and what do I fix first?" workflow as a
  user-invoked template — call `triage_repo` with the repo (and
  workflow, if given), report the root causes ranked real regressions
  first, then flaky, then unknown, and do not re-run or fix anything
  without the user agreeing. Tools are what the model calls on its
  own; a prompt is what the user picks from a menu in clients that
  surface prompts (Claude Desktop, Cursor, MCP Inspector), and our
  server previously offered nothing to pick. Wire-tested: list
  returns the one prompt, get renders the repo and workflow into the
  message, a missing repo and an unknown name are -32602 protocol
  errors. The method is FastMCP's — prompts are the third MCP
  primitive next to tools and resources, and FastMCP (the framework
  behind ~70% of MCP servers) treats them as a first-class surface.
  Honest limit: whether clients actually surface the prompt, and
  whether users click it, is only measurable in a real client
  session — the local proof is that the listing parses, the template
  renders, and the wire answers.

- New: the skill is now installable as a Claude Code plugin — this repo
  is a plugin marketplace (`.claude-plugin/marketplace.json`, one plugin,
  `strict: false`) shipping the skill at `skills/ci-triage/SKILL.md`.
  Claude Code users run `/plugin marketplace add WJDdidi-1/ci-triage`
  then `/plugin install ci-triage@ci-triage`, with no CLI install needed
  first (the skill falls back to npx). The repo copy is pinned
  byte-identical to the `--skill-generate` template by tests, so the two
  can never drift, and the marketplace version is pinned to the package
  version, like server.json. The method is anthropics/skills'
  marketplace distribution — one more discovery channel while
  distribution is the bottleneck. Honest limit: marketplace installs
  have no public count, so the local proof is that the listing parses,
  the skill path exists, and the copy matches the template; a real
  install still needs a Claude Code check.
- New: both MCP tool descriptions now say what the tool does, when to
  call it, and what it matches on ("Use when …" + "Keywords: …"). The
  descriptions used to say only what the tool does, so an agent had
  no trigger condition to decide on — the same spec rule our SKILL.md
  descriptions already follow. Tests pin both descriptions carry a
  when-clause and keywords; no parameters or behaviour changed. The
  method is anthropics/skills' description rule
  (agentskills.io/specification) + mcp-builder's discoverability.
- New: the generated SKILL.md now has an Examples section — two real
  runs against the test suite's fixture logs (one FLAKY Jest failure
  that passes in between, one real-regression TypeScript error that
  fails on every run) — and every Rule now states its why instead of
  a bare command (acting on the top cluster first "clears the most
  runs"). The example lines are pinned by tests that run the CLI
  against a mock GitHub API, so a future output-format change fails
  the suite until the skill is updated — the same drift guard as
  dev-diagnosis's demo tape. The method is anthropics/skills'
  skill-creator: give examples and explain why, never a bare
  ALWAYS/NEVER. 3 new tests.
- New: `doctor` now validates an installed SKILL.md's frontmatter
  against the Agent Skills spec (agentskills.io/specification) —
  name kebab-case and matching the skill directory, description
  1–1024 chars with no angle brackets, only known keys,
  compatibility at most 500 chars, non-empty body — instead of only
  checking the file exists. A broken frontmatter makes the skill
  silently never trigger, and `doctor` used to report it as
  installed and fine (demonstrated live: `name: Ci-Triage` with
  `<broken>` in the description passed the old check). A broken
  skill now warns, names the first problem (+N more), and prints the
  fix; it never fails the run, since the skill is advisory. Pure
  function `validateSkillMd` in `lib/skill.mjs`, no new dependency;
  15 new tests (14 validator, 1 doctor). The method is
  anthropics/skills' `quick_validate.py` — validate the skill you
  ship, don't just check it exists.
- `--annotations`: also emit each root cause as a GitHub Actions workflow-command annotation (`::error::` for a real regression, `::warning::` for flaky or unknown), so it surfaces on the run's annotations panel without opening the log. Needs no token and no file, works on fork PRs where the Checks API cannot write, and is a no-op locally. Capped at 10 per level (GitHub drops the rest silently); a clean window emits nothing, unreadable logs emit one warning. The method is reviewdog's `github-annotations` reporter — one result, many reporters.
- `--report <file>`: also write the triage as a Markdown report (the same Markdown as the Step Summary), for pasting into a PR, an issue, or an agent chat. Works with `--json` (confirmation on stderr, stdout stays parseable) and `--top`; an unwritable path exits 1 with a clear error.
- Mistyped options get a `Did you mean ...?` suggestion instead of a
  bare `unknown option` — `--hepl` suggests `--help`, `--jso` suggests
  `--json`. Levenshtein distance ≤ 2, the method git, gh (via Cobra)
  and cargo use; far-off typos still get no suggestion.
- MCP tools now carry `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so clients know both tools only read — `triage_repo` reaches the GitHub API, `triage_log` is pure computation — and need not ask before calling them.
- `completion <bash|zsh|fish>` prints a shell completion script, generated from the same option list the parser uses — so it can never suggest a flag the CLI rejects. The spec is the single source of truth (the bin derives its suggestion list from it), and a test checks it against `--help` in both directions. Value-taking options fall back to filename completion. The method is ripgrep's `complete/` scripts, without the static copy to go stale. Verified live: bash completes `completion z` to `zsh`, zsh registers the file via compinit.
- `doctor` checks the setup itself — Node version, `ci-triage` on PATH, home directory, installed skills, token availability, and whether the GitHub API answers (one cheap call, which also reports the rate-limit budget). Read-only, every failure with a copy-paste fix, `--json` for machines. The method is Claude Code's `claude doctor`, the same one dev-diagnosis uses; the token check names the token's source (GH_TOKEN, GITHUB_TOKEN, or `gh auth`) and never prints the token, like `gh auth status`. The check exists because our own dogfood on WJDdidi-1/dev-doctor came back UNKNOWN with 13 unreadable jobs — no token, no logs, no triage.

## 0.1.0 — 2026-11-13

First release.

- `ci-triage <owner/repo>`: fetch recent failed GitHub Actions runs, pull the failed job logs, group failures by root cause (error signatures with timestamps, paths, hashes and versions stripped), classify each cluster (test / build / infra), and separate real regressions from flaky failures using the run history. Ranked one-page report, `--json`, `--runs`, `--workflow`, `--branch`, `--top`.
- `--mcp`: stdio MCP server with `triage_repo` and `triage_log` tools, so any MCP-compatible agent can triage without reading raw logs.
- `--skill-generate`: write a Claude Agent Skills SKILL.md (project or global), never overwrites.
- `action.yml`: GitHub Action wrapper at the repo root.
- Zero runtime dependencies, pure Node.js standard library, Node >= 18.
