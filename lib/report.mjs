/**
 * Reporters: the ranked one-page text report, and the JSON object
 * the CLI prints with --json (which is the triage result itself).
 */

function shortDate(iso) {
  const d = new Date(iso);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function categoryWord(category) {
  return { test: 'test', build: 'build', infra: 'infra', unknown: 'unknown' }[category] || category;
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
  const flakyCount = result.clusters.filter((c) => c.flaky).length;
  const realCount = result.clusters.length - flakyCount;
  lines.push(`Root causes: ${result.clusters.length} (${realCount} real, ${flakyCount} flaky)`);
  lines.push('');
  const clusters = top == null ? result.clusters : result.clusters.slice(0, top);
  clusters.forEach((cluster, index) => {
    lines.push(`#${index + 1}  ${categoryWord(cluster.category)} · ${cluster.count} run${cluster.count > 1 ? 's' : ''} · ${cluster.flaky ? 'FLAKY' : 'real regression'}`);
    lines.push(`    ${cluster.headline}`);
    lines.push(`    ${cluster.categoryReason}. ${cluster.flakyReason}.`);
    lines.push(`    first seen ${shortDate(cluster.firstSeen)} · last seen ${shortDate(cluster.lastSeen)}`);
    lines.push(`    runs: ${cluster.runs.map((r) => `#${r.number} (${r.job})`).join(', ')}`);
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

/** One-line verdict for the CLI's final line. */
export function verdictLine(result) {
  if (result.clusters.length === 0 && result.failures.length === 0) return 'Overall: CLEAN — no failures in this window';
  if (result.clusters.length === 0) return `Overall: UNKNOWN — ${result.failures.length} failed job${result.failures.length > 1 ? 's' : ''} found, logs unreadable`;
  const flakyCount = result.clusters.filter((c) => c.flaky).length;
  const realCount = result.clusters.length - flakyCount;
  return `Overall: ${result.clusters.length} root cause${result.clusters.length > 1 ? 's' : ''} — ${realCount} real regression${realCount === 1 ? '' : 's'}, ${flakyCount} flaky`;
}

/** The JSON report is the result object, with --top applied to clusters. */
export function reportJson(result, { top = null } = {}) {
  if (top == null) return result;
  return { ...result, clusters: result.clusters.slice(0, top) };
}
