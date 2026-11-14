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
import path from 'node:path';
import { ApiError, UsageError } from '../lib/errors.mjs';
import { parseRepo } from '../lib/github.mjs';
import { runMcpServer } from '../lib/mcp.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { generateCompletion, knownOptions } from '../lib/completion.mjs';
import { formatAnnotations, formatReport, reportJson, starPromptLine, verdictLine, writeReportFile, writeStepSummary } from '../lib/report.mjs';
import { ensureAgentsSection, generateSkill } from '../lib/skill.mjs';
import { MAX_RUNS, triageRepo } from '../lib/triage.mjs';

const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const USAGE = `ci-triage: what's broken, what matters, what's flaky — for your repo's CI.

Usage:
  ci-triage <owner/repo> [--runs N] [--workflow <name>] [--branch <name>] [--json] [--top N] [--report <file>] [--annotations]
  ci-triage doctor [--json]
  ci-triage completion <bash|zsh|fish>
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
  --report <file>
                also write this triage as a Markdown report file
                (the same Markdown as the Step Summary — paste it
                into a PR, an issue, or an agent chat). Works with
                --json and --top; the confirmation goes to stderr
                under --json so stdout stays parseable.
  --annotations
                also emit each root cause as a GitHub Actions
                workflow-command annotation (::error:: for a real
                regression, ::warning:: for flaky or unknown) so it
                surfaces on the run's annotations panel without
                opening the log. Needs no token and no file — the
                same trick reviewdog's github-annotations reporter
                uses, and it works on fork PRs where the Checks API
                cannot write. A no-op locally: the lines only become
                annotations when a step runs in GitHub Actions.
                Goes to stderr under --json so stdout stays parseable.
  --mcp         serve the triage as an MCP server on stdio
  --skill-generate
                write a Claude Agent Skills SKILL.md for ci-triage:
                ./.claude/skills/ci-triage/SKILL.md by default
                (--project), or ~/.claude/skills/ci-triage/SKILL.md
                with --global. Refuses to overwrite an existing file.
                Also appends a short section to ./AGENTS.md (--project
                only), so agents that read AGENTS.md at startup find it.
  --global      with --skill-generate: write the skill to ~/.claude/skills
  --project     with --skill-generate: write the skill to ./.claude/skills
  -h, --help    show this help
  -v, --version print the version

Completion: ci-triage completion <bash|zsh|fish> prints a shell
completion script, generated from the same option list the CLI
parses, so it can never suggest a flag the CLI rejects. Install it
with e.g.: ci-triage completion bash > ~/.bash_completion.d/ci-triage

Auth: set GH_TOKEN (or GITHUB_TOKEN) for 5,000 GitHub API requests
per hour. GitHub does not allow anonymous job-log downloads, so
without a token the triage can list the failed runs and jobs but
cannot read their logs — it says so instead of pretending to
triage. gh auth login works too when the gh CLI is logged in.

Doctor: ci-triage doctor checks the setup itself: Node version,
ci-triage on PATH, the home directory --skill-generate writes
into, installed skills, whether a token is available, and whether
the GitHub API answers. Read-only — it changes nothing, so it
works even when the rest of the tool is misbehaving — and every
failure comes with a copy-paste fix. Warnings are for optional
wiring (a missing skill, no token, an unreachable API); only
failures make it exit 1. --json for machines. The method is
Claude Code's 'claude doctor'.

Exit codes: 0 = no failures in the window; 1 = failures found;
2 = usage error or the triage could not run.
`;

// The completion spec is the single source of truth for what the
// parser accepts: the suggestion list below is derived from it, so
// a flag added to the parser is automatically completable.
const KNOWN_OPTIONS = knownOptions();

// Levenshtein distance — small, dependency-free, used only to suggest a
// correction when the user mistypes an option. This is the method git,
// gh (via Cobra) and cargo all use: threshold 2 is Cobra's default
// SuggestionsMinimumDistance. A bare typo used to die with just
// "unknown option: --hepl" and a pointer to --help; now the error names
// the option the user almost certainly meant, so the fix is a retype,
// not a re-read of the help.
function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let corner = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        corner + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      corner = temp;
    }
  }
  return prev[b.length];
}

// Returns '' when nothing is close enough, otherwise one line (or, for
// several matches, a "one of these" list) ready to print after the
// error. Exact matches never reach here — the parser consumes them —
// so distance 0 is excluded, and a bare '-' suggests nothing.
function didYouMean(input, candidates) {
  if (!input || !input.replace(/^-+/, '')) return '';
  const matches = candidates
    .map((candidate) => ({ candidate, distance: levenshtein(input, candidate) }))
    .filter(({ distance }) => distance >= 1 && distance <= 2)
    .sort((x, y) => x.distance - y.distance || (x.candidate < y.candidate ? -1 : 1));
  if (matches.length === 0) return '';
  if (matches.length === 1) return `Did you mean '${matches[0].candidate}'?`;
  return `Did you mean one of these?\n${matches.map((m) => `  ${m.candidate}`).join('\n')}`;
}

function parseArgs(argv) {
  const parsed = {
    repo: null, positional: [], json: false, help: false, version: false,
    runs: null, workflow: null, branch: null, top: null, error: null,
    mcp: false, skillGenerate: false, skillGlobal: false, skillProject: false,
    report: null, annotations: false,
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
    } else if (arg === '--report') {
      parsed.report = argv[i + 1];
      if (parsed.report === undefined) parsed.error = '--report needs a value';
      i += 1;
    } else if (arg.startsWith('--report=')) {
      const value = arg.slice('--report='.length);
      if (!value) parsed.error = '--report needs a value';
      else parsed.report = value;
    } else if (arg === '--annotations') parsed.annotations = true;
    else if (arg.startsWith('-')) {
      // Suggest the option the user almost certainly meant
      // (--hepl -> --help); the part after '=' is a value, not part
      // of the name.
      const suggestion = didYouMean(arg.split('=')[0], KNOWN_OPTIONS);
      parsed.error = `unknown option: ${arg}${suggestion ? `\n${suggestion}` : ''}`;
    } else if (parsed.repo === null) parsed.repo = arg;
    else parsed.positional.push(arg);
    i += 1;
  }
  return parsed;
}

async function runDoctorCommand(args) {
  // Doctor takes no options except --json: the rest belong to the
  // triage, not to the checkup.
  if (args.runs != null || args.workflow || args.branch || args.top != null || args.report
    || args.annotations || args.skillGlobal || args.skillProject || args.positional.length > 0) {
    console.error('Error: doctor takes no options except --json.');
    console.error('Run with --help to see the available options.');
    return 2;
  }
  const result = await runDoctor();
  if (args.json) {
    console.log(JSON.stringify({ version: VERSION, ...result }, null, 2));
    return result.passed ? 0 : 1;
  }
  // Plain [ok]/[warn]/[FAIL] tags, no emoji: the output must read the
  // same on Windows consoles as on POSIX ones.
  for (const check of result.checks) {
    const tag = check.status === 'ok' ? 'ok' : check.status === 'warn' ? 'warn' : 'FAIL';
    console.log(`[${tag}] ${check.name} — ${check.detail}`);
    if (check.fix) console.log(`      Fix: ${check.fix}`);
  }
  const noun = result.failed === 1 ? 'check' : 'checks';
  console.log(result.passed
    ? `Doctor: healthy — ${result.checks.length} checks, ${result.warnings} warning(s)`
    : `Doctor: ${result.failed} failing ${noun} — see the fixes above`);
  return result.passed ? 0 : 1;
}

function runCompletion(positional) {
  const shell = positional[0];
  if (positional.length > 1) {
    console.error(`Error: unexpected argument: ${positional[1]}`);
    console.error('Run with --help to see the available options.');
    return 2;
  }
  if (!shell) {
    console.error('Error: completion needs a shell: bash, zsh or fish');
    console.error('Run with --help to see the available options.');
    return 2;
  }
  const script = generateCompletion(shell);
  if (script === null) {
    console.error(`Error: unknown shell: ${shell} (expected one of bash, zsh, fish)`);
    console.error('Run with --help to see the available options.');
    return 2;
  }
  console.log(script);
  return 0;
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
    if (args.repo || args.json || args.runs != null || args.workflow || args.branch || args.top != null || args.report || args.annotations) {
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
    if (args.repo || args.json || args.runs != null || args.workflow || args.branch || args.top != null || args.report || args.annotations) {
      console.error('Error: --skill-generate takes no other arguments.');
      console.error('Run with --help to see the available options.');
      return 2;
    }
    const scope = args.skillGlobal ? 'global' : 'project';
    // The AGENTS.md section goes in first, so a re-run that refuses
    // to overwrite an existing SKILL.md still leaves the repo with
    // the discovery entry point — it is append-only and idempotent.
    const agents = ensureAgentsSection(scope);
    if (agents.status === 'created') console.log(`Wrote ${agents.path}`);
    else if (agents.status === 'appended') console.log(`Appended a section to ${agents.path}`);
    else if (agents.status === 'skipped') console.log(`Note: ${agents.reason}`);
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
  if (args.repo === 'doctor') {
    return runDoctorCommand(args);
  }
  if (args.repo === 'completion') {
    return runCompletion(args.positional);
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
      if (args.report) {
        // stderr, not stdout: the JSON on stdout stays parseable,
        // and the confirmation still reaches the user.
        if (!writeReportFile(result, args.report, { top: args.top })) return 1;
        console.error(`Wrote report to ${path.resolve(args.report)}`);
      }
      console.log(JSON.stringify(reportJson(result, { top: args.top }), null, 2));
    } else {
      console.log(formatReport(result, { top: args.top }));
      console.log('');
      console.log(verdictLine(result));
      // One-line star ask, interactive terminals only: it never reaches
      // --json output or a pipe, so parsers and report files stay clean.
      const star = starPromptLine(process.stdout.isTTY);
      if (star) console.log(star);
      if (args.report) {
        if (!writeReportFile(result, args.report, { top: args.top })) return 1;
        console.log(`Wrote report to ${path.resolve(args.report)}`);
      }
    }
    // The Step Summary is where the Actions page shows the result;
    // locally GITHUB_STEP_SUMMARY is unset and this is a no-op. It
    // runs for --json too — the summary file is separate from stdout,
    // so machine output stays clean.
    writeStepSummary(result, { top: args.top });
    // Annotations are where the Actions page surfaces the failure;
    // the Step Summary is a separate tab and the log needs opening.
    // Under --json they go to stderr, so stdout stays parseable.
    if (args.annotations) {
      const annotations = formatAnnotations(result, { top: args.top });
      if (annotations) {
        if (args.json) console.error(annotations);
        else console.log(annotations);
      }
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
