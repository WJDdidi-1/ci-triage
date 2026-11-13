# Changelog

## 0.1.0 — 2026-11-13

First release.

- `ci-triage <owner/repo>`: fetch recent failed GitHub Actions runs, pull the failed job logs, group failures by root cause (error signatures with timestamps, paths, hashes and versions stripped), classify each cluster (test / build / infra), and separate real regressions from flaky failures using the run history. Ranked one-page report, `--json`, `--runs`, `--workflow`, `--branch`, `--top`.
- `--mcp`: stdio MCP server with `triage_repo` and `triage_log` tools, so any MCP-compatible agent can triage without reading raw logs.
- `--skill-generate`: write a Claude Agent Skills SKILL.md (project or global), never overwrites.
- `action.yml`: GitHub Action wrapper at the repo root.
- Zero runtime dependencies, pure Node.js standard library, Node >= 18.
