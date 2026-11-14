# Changelog

## 0.1.1 — 2026-11-14

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
