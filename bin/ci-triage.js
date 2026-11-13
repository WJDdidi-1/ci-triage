#!/usr/bin/env node
/**
 * ci-triage — cross-run CI failure triage for GitHub Actions.
 *
 * CI goes red and nobody knows which failures matter. ci-triage
 * pulls the recent failed runs, downloads the failed job logs, and
 * answers "what's broken, what matters, what's flaky" in one page:
 * failures grouped by root cause, classified (test / build / infra),
 * and separated into real regressions and flaky failures using the
 * run history.
 *
 * Standard-library Node.js only. Auth via GH_TOKEN (or GITHUB_TOKEN,
 * or `gh auth` when logged in); public repos work unauthenticated
 * at 60 GitHub API requests/hour.
 *
 * Exit codes: 0 = no failures in the window (clean); 1 = failures
 * found (the normal case when CI is red — the report is the answer);
 * 2 = usage error or the triage could not run (API error, no
 * network, bad repo name).
 *
 * Agent modes: --mcp serves the triage as MCP tools over stdio (see
 * lib/mcp.mjs); --skill-generate writes a Claude Agent Skills
 * SKILL.md that tells an agent to triage before reading any log
 * (see lib/skill.mjs).
 */
import fs from 'node:fs';
import { ApiError, UsageError } from '../lib/errors.mjs';
import { parseRepo } from '../lib/github.mjs';
import { runMcpServer } from '../lib/mcp.mjs';
import { formatReport, reportJson, verdictLine } from '../lib/report.mjs';
import { generateSkill } from '../lib/skill.mjs';
import { MAX_RUNS, triageRepo } from '../lib/triage.mjs';

const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const USAGE = `ci-triage: what's broken, what matters, what's flaky — for your repo's CI.

Usage:
  ci-triage <owner/repo> [--runs N] [--workflow <name>] [--branch <name>] [--json] [--top N]
  ci-triage --mcp
  ci-triage --skill-generate [--global | --project]
  ci-triage --help
  ci-triage --version

Arguments:
  <owner/repo>  the repo to triage (a github.com URL works too)

Options:
  --runs N      failed runs to examine (default 10, max ${MAX_RUNS})
  --workflow <name>
                only this workflow (file name or id)
  --branch <name>
                only this branch
  --json        machine-readable output
  --top N       show only the N highest-ranked root causes
  --mcp         serve the triage as an MCP server on stdio
  --skill-generate
                write a Claude Agent Skills SKILL.md for ci-triage:
                ./.claude/skills/ci-triage/SKILL.md by default
                (--project), or ~/.claude/skills/ci-triage/SKILL.md
                with --global. Refuses to overwrite an existing file.
  --global      with --skill-generate: write the skill to ~/.claude/skills
  --project     with --skill-generate: write the skill to ./.claude/skills
  -h, --help    show this help
  -v, --version print the version

Auth: set GH_TOKEN (or GITHUB_TOKEN) for 5,000 GitHub API requests
per hour. GitHub does not allow anonymous job-log downloads, so
without a token the triage can list the failed runs and jobs but
cannot read their logs — it says so instead of pretending to
triage. gh auth login works too when the gh CLI is logged in.

Exit codes: 0 = no failures in the window; 1 = failures found;
2 = usage error or the triage could not run.
`;

function parseArgs(argv) {
  const parsed = {
    repo: null, positional: [], json: false, help: false, version: false,
    runs: null, workflow: null, branch: null, top: null, error: null,
    mcp: false, skillGenerate: false, skillGlobal: false, skillProject: false,
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--json' || arg === '-j') parsed.json = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--version' || arg === '-v') parsed.version = true;
    else if (arg === '--mcp') parsed.mcp = true;
    else if (arg === '--skill-generate') parsed.skillGenerate = true;
    else if (arg === '--global') parsed.skillGlobal = true;
    else if (arg === '--project') parsed.skillProject = true;
    else if (arg === '--runs') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > MAX_RUNS) parsed.error = `--runs needs an integer between 1 and ${MAX_RUNS}`;
      else parsed.runs = value;
      i += 1;
    } else if (arg.startsWith('--runs=')) {
      const value = Number(arg.slice('--runs='.length));
      if (!Number.isInteger(value) || value < 1 || value > MAX_RUNS) parsed.error = `--runs needs an integer between 1 and ${MAX_RUNS}`;
      else parsed.runs = value;
    } else if (arg === '--workflow') {
      parsed.workflow = argv[i + 1];
      if (parsed.workflow === undefined) parsed.error = '--workflow needs a value';
      i += 1;
    } else if (arg.startsWith('--workflow=')) parsed.workflow = arg.slice('--workflow='.length);
    else if (arg === '--branch') {
      parsed.branch = argv[i + 1];
      if (parsed.branch === undefined) parsed.error = '--branch needs a value';
      i += 1;
    } else if (arg.startsWith('--branch=')) parsed.branch = arg.slice('--branch='.length);
    else if (arg === '--top') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) parsed.error = '--top needs a positive integer';
      else parsed.top = value;
      i += 1;
    } else if (arg.startsWith('--top=')) {
      const value = Number(arg.slice('--top='.length));
      if (!Number.isInteger(value) || value < 1) parsed.error = '--top needs a positive integer';
      else parsed.top = value;
    } else if (arg.startsWith('-')) {
      parsed.error = `unknown option: ${arg}`;
    } else if (parsed.repo === null) parsed.repo = arg;
    else parsed.positional.push(arg);
    i += 1;
  }
  return parsed;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(`Error: ${args.error}`);
    console.error('Run with --help to see the available options.');
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.version) {
    console.log(VERSION);
    return 0;
  }
  const modes = [args.mcp, args.skillGenerate].filter(Boolean).length;
  if (modes > 1) {
    console.error('Error: --mcp and --skill-generate cannot be combined.');
    console.error('Run with --help to see the available options.');
    return 2;
  }
  if (args.mcp) {
    if (args.repo || args.json || args.runs != null || args.workflow || args.branch || args.top != null) {
      console.error('Error: --mcp takes no other arguments.');
      console.error('Run with --help to see the available options.');
      return 2;
    }
    await runMcpServer({ version: VERSION });
    return 0;
  }
  if (args.skillGenerate) {
    if (args.skillGlobal && args.skillProject) {
      console.error('Error: choose one of --global or --project for --skill-generate.');
      console.error('Run with --help to see the available options.');
      return 2;
    }
    if (args.repo || args.json || args.runs != null || args.workflow || args.branch || args.top != null) {
      console.error('Error: --skill-generate takes no other arguments.');
      console.error('Run with --help to see the available options.');
      return 2;
    }
    const scope = args.skillGlobal ? 'global' : 'project';
    const out = generateSkill(scope);
    if (!out.created) {
      console.error(`Error: ${out.reason} — refusing to overwrite it.`);
      return 1;
    }
    console.log(`Wrote ${out.path}`);
    return 0;
  }
  if (args.skillGlobal || args.skillProject) {
    console.error('Error: --global and --project only apply to --skill-generate.');
    console.error('Run with --help to see the available options.');
    return 2;
  }
  if (!args.repo) {
    console.error('Error: a repository is required: ci-triage <owner/repo>');
    console.error('Run with --help to see the available options.');
    return 2;
  }
  if (args.positional.length > 0) {
    console.error(`Error: unexpected argument: ${args.positional[0]}`);
    console.error('Run with --help to see the available options.');
    return 2;
  }
  try {
    parseRepo(args.repo);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error('Run with --help to see the available options.');
    return 2;
  }
  try {
    const result = await triageRepo(args.repo, {
      runs: args.runs ?? undefined,
      workflow: args.workflow,
      branch: args.branch,
      onProgress: (line) => { if (!args.json) console.error(line); },
    });
    if (args.json) {
      console.log(JSON.stringify(reportJson(result, { top: args.top }), null, 2));
    } else {
      console.log(formatReport(result, { top: args.top }));
      console.log('');
      console.log(verdictLine(result));
    }
    // 1 when failures were found — even when their logs could not
    // be read, because the repo is not clean; 0 only when no failed
    // job turned up at all.
    return result.clusters.length === 0 && result.failures.length === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError || error instanceof ApiError) {
      console.error(`Error: ${error.message}`);
      return 2;
    }
    console.error(`Error: ${error.message}`);
    return 2;
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
