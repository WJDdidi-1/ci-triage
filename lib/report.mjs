/**
 * Reporters: the ranked one-page text report, and the JSON object
 * the CLI prints with --json (which is the triage result itself).
 * `formatSummary` is the same report as Markdown, for the GitHub
 * Step Summary — results should appear where the user already looks
 * (the Actions page), not only in the job log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { extractFileLocation } from './signature.mjs';

function shortDate(iso) {
  const d = new Date(iso);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function categoryWord(category) {
  return { test: 'test', build: 'build', infra: 'infra', unknown: 'unknown' }[category] || category;
}

function shortSha(sha) {
  return sha.slice(0, 7);
}

function runRef(end) {
  return end.number != null ? `#${end.number} (${shortSha(end.headSha)})` : shortSha(end.headSha);
}

/**
 * One line naming the regression window for a cluster — git
 * bisect's range, from the last green run to the first red one,
 * with the `git log` command that lists the suspect commits.
 * Null when there is no window to name (a flaky cluster has no
 * single boundary; the flaky reason already says so). A non-flaky
 * cluster with no green run in the window gets the honest version
 * of the line instead: the regression predates the runs listed.
 */
function regressionWindowLine(cluster) {
  if (cluster.flaky) return null;
  const window = cluster.regressionWindow;
  if (!window) return null;
  if (window.lastGreen == null) {
    return 'no passing run before the first failure in this window — the regression predates the runs listed';
  }
  const { lastGreen, firstRed } = window;
  return `broke between ${runRef(lastGreen)} and ${runRef(firstRed)} — git log ${shortSha(lastGreen.headSha)}..${shortSha(firstRed.headSha)} lists the suspect commits`;
}

/**
 * How much of the failure mass the top clusters represent (the ranked-
 * budget view: Aider's repomap, Repomix's token-count tree). The report
 * ranks clusters but never said whether fixing #1 clears 80% of the
 * failures or 20% — this line says it. Null when there is nothing to
 * rank (fewer than two clusters).
 */
function topClusterShareLine(result) {
  if (result.clusters.length < 2 || result.failures.length === 0) return null;
  const ranked = [...result.clusters].sort((a, b) => b.count - a.count);
  const n = Math.min(2, ranked.length);
  const covered = ranked.slice(0, n).reduce((sum, c) => sum + c.count, 0);
  const pct = Math.round((covered / result.failures.length) * 1000) / 10;
  return `Top ${n} root causes cover ${covered} of ${result.failures.length} failures (${pct}%)`;
}

/**
 * The text report. One page: the window, then one block per cluster,
 * ranked. A cluster block says what broke, how often, whether it is
 * flaky, which runs it hit, and the evidence lines — enough to act
 * without re-downloading any log.
 */
export function formatReport(result, { top = null } = {}) {
  const lines = [];
  lines.push(`ci-triage — ${result.repo}`);
  if (result.workflow) lines.push(`Workflow: ${result.workflow}`);
  if (result.branch) lines.push(`Branch: ${result.branch}`);
  lines.push(`Window: ${result.window.runsListed} recent runs listed, ${result.window.failedRuns} failed examined`);
  if (result.clusters.length === 0) {
    lines.push('');
    if (result.failures.length === 0) {
      lines.push('No failures found in this window — CI is green.');
    } else {
      // Failed jobs exist but none could be read: calling that CLEAN
      // would be a lie, so say what happened instead.
      lines.push(`No clusters: ${result.failures.length} failed job${result.failures.length > 1 ? 's' : ''} found, but their logs could not be read.`);
      const reasons = [...new Set(result.failures.filter((f) => f.logError).map((f) => f.logError))];
      if (reasons.length > 0) {
        const reason = reasons[0].length > 160 ? `${reasons[0].slice(0, 157)}…` : reasons[0];
        lines.push(`Reason: ${reason}`);
      }
    }
    lines.push(`Fetched: ${result.fetchedAt}`);
    return lines.join('\n');
  }
  const flakyCount = result.clusters.filter((c) => c.flaky && !c.known).length;
  const knownCount = result.clusters.filter((c) => c.known).length;
  const realCount = result.clusters.length - flakyCount - knownCount;
  lines.push(`Root causes: ${result.clusters.length} (${realCount} real, ${flakyCount} flaky${knownCount > 0 ? `, ${knownCount} known` : ''})`);
  const share = topClusterShareLine(result);
  if (share) lines.push(share);
  lines.push('');
  const clusters = top == null ? result.clusters : result.clusters.slice(0, top);
  clusters.forEach((cluster, index) => {
    const verdict = cluster.known ? 'known failure' : cluster.flaky ? 'FLAKY' : 'real regression';
    lines.push(`#${index + 1}  ${categoryWord(cluster.category)} · ${cluster.count} run${cluster.count > 1 ? 's' : ''} · ${verdict}`);
    lines.push(`    ${cluster.headline}`);
    lines.push(`    ${cluster.categoryReason}. ${cluster.flakyReason}.`);
    if (cluster.known) {
      lines.push(`    Recorded as a known failure — not a new regression.`);
    }
    lines.push(`    first seen ${shortDate(cluster.firstSeen)} · last seen ${shortDate(cluster.lastSeen)}`);
    lines.push(`    runs: ${cluster.runs.map((r) => `#${r.number} (${r.job})`).join(', ')}`);
    const windowLine = regressionWindowLine(cluster);
    if (windowLine) lines.push(`    ${windowLine}`);
    if (cluster.evidence && cluster.evidence.length > 0) {
      lines.push('    evidence:');
      for (const line of cluster.evidence) lines.push(`      ${line}`);
    }
    lines.push('');
  });
  if (top != null && result.clusters.length > top) {
    lines.push(`… and ${result.clusters.length - top} more root cause${result.clusters.length - top > 1 ? 's' : ''} (use --top ${result.clusters.length} to see them all)`);
    lines.push('');
  }
  const notSeen = result.knownFailures?.notSeen || [];
  if (notSeen.length > 0) {
    lines.push(`Known failures not seen in this window (possibly fixed — remove them from ${result.knownFailures.file} if so):`);
    for (const entry of notSeen) {
      lines.push(`  ${entry.signature}${entry.headline ? ` — ${entry.headline}` : ''}`);
    }
    lines.push('');
  }
  const unclustered = result.failures.filter((f) => f.signature == null).length;
  if (unclustered > 0) {
    lines.push(`Note: ${unclustered} failed job${unclustered > 1 ? 's' : ''} had no readable log and could not be clustered.`);
    const reasons = [...new Set(result.failures.filter((f) => f.signature == null && f.logError).map((f) => f.logError))];
    if (reasons.length > 0) {
      const reason = reasons[0].length > 160 ? `${reasons[0].slice(0, 157)}…` : reasons[0];
      lines.push(`Reason: ${reason}`);
    }
    lines.push('');
  }
  lines.push(`Fetched: ${result.fetchedAt}`);
  return lines.join('\n');
}

/**
 * The same one-page report as Markdown, for the GitHub Step Summary.
 * Mirrors formatReport section for section — window, ranked clusters
 * with evidence, the unclustered note — so what the Actions page
 * shows is the report the CLI printed, not a different summary.
 */
export function formatSummary(result, { top = null } = {}) {
  const lines = [];
  lines.push(`## ci-triage — ${result.repo}`);
  if (result.workflow) lines.push(`Workflow: ${result.workflow}`);
  if (result.branch) lines.push(`Branch: ${result.branch}`);
  lines.push(`Window: ${result.window.runsListed} recent runs listed, ${result.window.failedRuns} failed examined`);
  if (result.clusters.length === 0) {
    lines.push('');
    if (result.failures.length === 0) {
      lines.push('**No failures found in this window — CI is green.**');
    } else {
      lines.push(`**No clusters:** ${result.failures.length} failed job${result.failures.length > 1 ? 's' : ''} found, but their logs could not be read.`);
      const reasons = [...new Set(result.failures.filter((f) => f.logError).map((f) => f.logError))];
      if (reasons.length > 0) {
        const reason = reasons[0].length > 160 ? `${reasons[0].slice(0, 157)}…` : reasons[0];
        lines.push(`Reason: ${reason}`);
      }
    }
    lines.push('');
    lines.push(`Fetched: ${result.fetchedAt}`);
    return lines.join('\n');
  }
  const flakyCount = result.clusters.filter((c) => c.flaky && !c.known).length;
  const knownCount = result.clusters.filter((c) => c.known).length;
  const realCount = result.clusters.length - flakyCount - knownCount;
  lines.push(`**Root causes: ${result.clusters.length} (${realCount} real, ${flakyCount} flaky${knownCount > 0 ? `, ${knownCount} known` : ''})**`);
  const share = topClusterShareLine(result);
  if (share) lines.push(`**${share}**`);
  lines.push('');
  const clusters = top == null ? result.clusters : result.clusters.slice(0, top);
  clusters.forEach((cluster, index) => {
    const verdict = cluster.known ? 'known failure' : cluster.flaky ? 'FLAKY' : 'real regression';
    lines.push(`### #${index + 1} ${categoryWord(cluster.category)} · ${cluster.count} run${cluster.count > 1 ? 's' : ''} · ${verdict}`);
    lines.push('');
    lines.push(`**${cluster.headline}**`);
    lines.push('');
    lines.push(`${cluster.categoryReason}. ${cluster.flakyReason}.`);
    if (cluster.known) {
      lines.push('');
      lines.push('Recorded as a known failure — not a new regression.');
    }
    lines.push('');
    lines.push(`first seen ${shortDate(cluster.firstSeen)} · last seen ${shortDate(cluster.lastSeen)}`);
    lines.push('');
    lines.push(`runs: ${cluster.runs.map((r) => `#${r.number} (${r.job})`).join(', ')}`);
    const windowLine = regressionWindowLine(cluster);
    if (windowLine) {
      lines.push('');
      lines.push(windowLine);
    }
    if (cluster.evidence && cluster.evidence.length > 0) {
      lines.push('');
      lines.push('evidence:');
      for (const line of cluster.evidence) lines.push(`- ${line}`);
    }
    lines.push('');
  });
  if (top != null && result.clusters.length > top) {
    lines.push(`… and ${result.clusters.length - top} more root cause${result.clusters.length - top > 1 ? 's' : ''} (use --top ${result.clusters.length} to see them all)`);
    lines.push('');
  }
  const notSeen = result.knownFailures?.notSeen || [];
  if (notSeen.length > 0) {
    lines.push(`Known failures not seen in this window (possibly fixed — remove them from ${result.knownFailures.file} if so):`);
    for (const entry of notSeen) {
      lines.push(`- ${entry.signature}${entry.headline ? ` — ${entry.headline}` : ''}`);
    }
    lines.push('');
  }
  const unclustered = result.failures.filter((f) => f.signature == null).length;
  if (unclustered > 0) {
    lines.push(`Note: ${unclustered} failed job${unclustered > 1 ? 's' : ''} had no readable log and could not be clustered.`);
    const reasons = [...new Set(result.failures.filter((f) => f.signature == null && f.logError).map((f) => f.logError))];
    if (reasons.length > 0) {
      const reason = reasons[0].length > 160 ? `${reasons[0].slice(0, 157)}…` : reasons[0];
      lines.push(`Reason: ${reason}`);
    }
    lines.push('');
  }
  lines.push(`Fetched: ${result.fetchedAt}`);
  return lines.join('\n');
}

/**
 * Append the Markdown report to the GitHub Step Summary file, when
 * the run is inside GitHub Actions (GITHUB_STEP_SUMMARY set). Local
 * runs do nothing: the variable is unset outside Actions. A failure
 * to write the summary never fails the triage — it is a display side
 * effect, so it warns on stderr and the exit code still follows the
 * triage result. Returns true when written, false otherwise.
 */
export function writeStepSummary(result, { top = null, env = process.env } = {}) {
  const file = env.GITHUB_STEP_SUMMARY;
  if (!file) return false;
  try {
    fs.appendFileSync(file, `${formatSummary(result, { top })}\n`);
    return true;
  } catch (error) {
    console.error(`Warning: could not write the step summary to ${file}: ${error.message}`);
    return false;
  }
}

// Workflow-command escaping, per the GitHub Actions spec: the
// message escapes %, CR and LF; a property value (the title) escapes
// those plus : and ,.
function escapeAnnotationData(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeAnnotationProperty(text) {
  return escapeAnnotationData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

// GitHub drops workflow-command annotations past 10 per level per
// step, silently — so cap the output there instead of emitting lines
// that vanish. The full report still lists every cluster.
const MAX_ANNOTATIONS_PER_LEVEL = 10;

/**
 * GitHub Actions workflow-command annotations — the same triage, as
 * `::error::` / `::warning::` lines, so the root causes surface on
 * the run's annotations panel without opening the log. The method is
 * reviewdog's `-reporter=github-annotations`: one result, many
 * reporters — deliver it where the user already looks. Unlike the
 * Step Summary it needs no file, unlike --report it needs no
 * upload, and unlike the Checks API it needs no token — which is
 * why reviewdog falls back to exactly this on fork PRs, where the
 * API cannot write. Real regressions are errors; flaky and unknown
 * clusters are warnings, so an uncertain cause never presents as a
 * certain one. A clean window emits nothing; failed jobs whose logs
 * could not be read emit one warning, the same honesty as the
 * report. Returns '' when there is nothing to annotate.
 */
export function formatAnnotations(result, { top = null } = {}) {
  const lines = [];
  const counts = { error: 0, warning: 0 };
  const clusters = top == null ? result.clusters : result.clusters.slice(0, top);
  clusters.forEach((cluster, index) => {
    const level = cluster.known || cluster.category === 'unknown' || cluster.flaky ? 'warning' : 'error';
    if (counts[level] >= MAX_ANNOTATIONS_PER_LEVEL) return;
    counts[level] += 1;
    const verdict = cluster.known ? 'known failure' : cluster.flaky ? 'flaky' : 'real regression';
    const title = `ci-triage ${result.repo} — #${index + 1} ${categoryWord(cluster.category)} · ${cluster.count} run${cluster.count > 1 ? 's' : ''} · ${verdict}`;
    const runs = cluster.runs.length > 0
      ? cluster.runs.map((r) => `#${r.number} (${r.job})`).join(', ')
      : 'no runs listed';
    let message = `${cluster.headline}. Runs: ${runs}. ${cluster.categoryReason}. ${cluster.flakyReason}.`;
    if (cluster.known) message += ' Recorded as a known failure — not a new regression.';
    const window = cluster.regressionWindow;
    if (!cluster.flaky && window && window.lastGreen) {
      message += ` Broke between ${runRef(window.lastGreen)} and ${runRef(window.firstRed)}.`;
    }
    if (message.length > 1500) message = `${message.slice(0, 1499)}…`;
    // Pin the annotation to the failing file and line when the log
    // names one (the signature carries it; hand-built results fall
    // back to scanning the evidence); without it the line stays a
    // bare ::error:: / ::warning:: on the run's panel.
    const location = cluster.location || extractFileLocation(cluster.evidence);
    const props = location
      ? `file=${escapeAnnotationProperty(location.file)},line=${location.line},title=${escapeAnnotationProperty(title)}`
      : `title=${escapeAnnotationProperty(title)}`;
    lines.push(`::${level} ${props}::${escapeAnnotationData(message)}`);
  });
  if (result.clusters.length === 0 && result.failures.length > 0) {
    // Same honesty as the report: failed jobs with unreadable logs
    // are UNKNOWN, not clean — one warning, not an error.
    const reasons = [...new Set(result.failures.filter((f) => f.logError).map((f) => f.logError))];
    let message = `${result.failures.length} failed job${result.failures.length > 1 ? 's' : ''} found, but their logs could not be read.`;
    if (reasons.length > 0) message += ` Reason: ${reasons[0]}`;
    if (message.length > 1500) message = `${message.slice(0, 1499)}…`;
    lines.push(`::warning title=${escapeAnnotationProperty(`ci-triage ${result.repo} — logs unreadable`)}::${escapeAnnotationData(message)}`);
  }
  return lines.join('\n');
}

/**
 * Write the Markdown report to a file, for pasting into a PR, an
 * issue, or an agent chat. Same Markdown as the Step Summary — one
 * function, two destinations — so the file, the summary, and the
 * terminal report never disagree. Returns true on success; on
 * failure the reason goes to stderr and the caller exits 1, so a
 * missing report is never silent.
 */
export function writeReportFile(result, reportPath, { top = null } = {}) {
  const target = path.resolve(reportPath);
  try {
    fs.writeFileSync(target, `${formatSummary(result, { top })}\n`, 'utf8');
  } catch (error) {
    console.error(`Error: could not write report to ${target}: ${error.message}`);
    return false;
  }
  return true;
}

/** One-line verdict for the CLI's final line. */
export function verdictLine(result) {
  if (result.clusters.length === 0 && result.failures.length === 0) return 'Overall: CLEAN — no failures in this window';
  if (result.clusters.length === 0) return `Overall: UNKNOWN — ${result.failures.length} failed job${result.failures.length > 1 ? 's' : ''} found, logs unreadable`;
  const flakyCount = result.clusters.filter((c) => c.flaky && !c.known).length;
  const knownCount = result.clusters.filter((c) => c.known).length;
  const realCount = result.clusters.length - flakyCount - knownCount;
  if (knownCount === result.clusters.length && result.failures.every((f) => f.signature != null)) {
    // Playwright's test.fail() semantics: a failure the team already
    // knows about does not fail the suite — but only when every
    // failure in the window is a known one. An unreadable log cannot
    // be matched to the known file, so it still fails (UNKNOWN).
    return `Overall: KNOWN — ${knownCount} known failure${knownCount === 1 ? '' : 's'}, no new regressions`;
  }
  return `Overall: ${result.clusters.length} root cause${result.clusters.length > 1 ? 's' : ''} — ${realCount} real regression${realCount === 1 ? '' : 's'}, ${flakyCount} flaky${knownCount > 0 ? `, ${knownCount} known` : ''}`;
}

/**
 * One-line ask for a star, printed after the verdict of an interactive
 * report only. Machine output (--json) never sees it — a prompt in
 * JSON would break parsers — and piped output never sees it either,
 * so `ci-triage o/r > report.txt` and CI logs stay clean.
 * Returns the line, or null when it should not print.
 */
export function starPromptLine(isTTY) {
  if (!isTTY) return null;
  return 'If this saved you time, star ci-triage: https://github.com/WJDdidi-1/ci-triage';
}

/** The JSON report is the result object, with --top applied to clusters. */
export function reportJson(result, { top = null } = {}) {
  if (top == null) return result;
  return { ...result, clusters: result.clusters.slice(0, top) };
}
