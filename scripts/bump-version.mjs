#!/usr/bin/env node
/**
 * bump-version.mjs — bump the release version in every place that pins it.
 *
 * Usage:
 *   node scripts/bump-version.mjs <new-version> [--date YYYY-MM-DD] [--root <dir>]
 *
 * The version lives in more than one file: package.json, package-lock.json
 * (two fields), server.json (two fields), .claude-plugin/marketplace.json,
 * the pre-commit manifest's pinned dependency and documented rev,
 * the README's documented rev, and the demo tape's GIF label — plus the
 * CHANGELOG's `## Unreleased` heading, which becomes the new version.
 * Editing them by hand is how a release gets a stale pin and a red CI
 * run (the lockstep tests exist because that happened); this script is
 * the only writer of version strings. It refuses a drifted tree
 * before writing anything, and verifies its own work afterwards —
 * semantic-release's method, without adopting semantic-release itself
 * (our releases are nightly-batched and human-approved, and our
 * commits are API pushes, not Conventional Commits, so a full
 * release-automation tool does not fit).
 *
 * Rules:
 * - Files that do not exist in this repo are skipped, so the same
 *   script works in both repos (ci-triage has no pre-commit manifest,
 *   no demo tape, no README rev).
 * - Only structured version fields are touched, never prose: a
 *   CHANGELOG entry that says "fixed in 0.2.3" stays as history.
 * - The date defaults to today in Asia/Shanghai (the maintainer's
 *   timezone, matching the CHANGELOG's dates); pass --date to override.
 * - After editing, every version mention is re-read and must equal the
 *   new version; a stale pin anywhere fails the run instead of
 *   shipping a half-bumped tree.
 * - After bumping, re-render the demo GIF (`npm run demo`) — the tape
 *   label changed, so the GIF is stale until then.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function usage() {
  return 'usage: node scripts/bump-version.mjs <new-version> [--date YYYY-MM-DD] [--root <dir>]';
}

function fail(message) {
  process.stderr.write(`bump-version: ${message}\n`);
  return 1;
}

function shanghaiDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function replaceAll(text, from, to) {
  return text.split(from).join(to);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A `"version": "x"` field in JSON, tolerating either spacing style:
// package-lock.json / marketplace.json are pretty-printed
// (`"version": "0.2.3"`), while ci-triage's package.json and both
// server.json files are minified (`"version":"0.1.1"`). The separator
// is preserved, so the bump never reformats a file.
function versionFieldRe(old) {
  return new RegExp(`"version"(\\s*:\\s*)"${escapeRegExp(old)}"`, 'g');
}

function replaceVersionField(text, old, version) {
  return text.replace(versionFieldRe(old), (m, sep) => `"version"${sep}"${version}"`);
}

function countVersionFields(text, old) {
  return (text.match(versionFieldRe(old)) || []).length;
}

export function main(argv = process.argv.slice(2)) {
  let version = null;
  let date = null;
  let root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--date') {
      date = argv[++i];
      if (!date || !DATE_RE.test(date)) return fail('--date needs YYYY-MM-DD');
    } else if (arg === '--root') {
      root = argv[++i];
      if (!root) return fail('--root needs a directory');
    } else if (arg.startsWith('--')) {
      return fail(`unknown option ${arg}\n${usage()}`);
    } else if (version === null) {
      version = arg;
    } else {
      return fail(`unexpected argument ${arg}\n${usage()}`);
    }
  }
  if (version === null) return fail(`missing <new-version>\n${usage()}`);
  if (!VERSION_RE.test(version)) {
    return fail(`not a plain x.y.z version: ${version}`);
  }
  if (date === null) date = shanghaiDate();

  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  const write = (rel, text) => fs.writeFileSync(path.join(root, rel), text);

  let pkg;
  try {
    pkg = JSON.parse(read('package.json'));
  } catch (error) {
    return fail(`cannot read package.json: ${error.message}`);
  }
  const old = pkg.version;
  const name = pkg.name;
  if (typeof old !== 'string' || !VERSION_RE.test(old)) {
    return fail(`package.json has no plain x.y.z version: ${String(old)}`);
  }
  if (old === version) {
    process.stdout.write(`bump-version: already at ${version}; nothing to change\n`);
    return 0;
  }

  // Pre-flight: verify every present file holds the old version where it
  // should, BEFORE writing anything — a drifted tree (e.g. a README rev
  // left at an older release) is refused outright instead of half-bumped.
  const preflight = [];
  const expect = (label, ok) => { if (!ok) preflight.push(label); };
  try {
    expect('package.json version', countVersionFields(read('package.json'), old) === 1);
    if (exists('package-lock.json')) {
      expect('package-lock.json version', countVersionFields(read('package-lock.json'), old) >= 1);
    }
    if (exists('server.json')) {
      expect('server.json version', countVersionFields(read('server.json'), old) >= 1);
    }
    const marketRel = path.join('.claude-plugin', 'marketplace.json');
    if (exists(marketRel)) {
      expect('marketplace.json version', countVersionFields(read(marketRel), old) === 1);
    }
    if (exists('.pre-commit-hooks.yaml')) {
      const manifest = read('.pre-commit-hooks.yaml');
      expect('pre-commit pinned dependency', manifest.includes(`${name}@${old}`));
      expect('pre-commit documented rev', manifest.includes(`rev: v${old}`));
    }
    if (exists('README.md')) {
      const revs = [...read('README.md').matchAll(/rev: v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
      expect('README documented rev', revs.every((v) => v === old));
    }
    const tapeRel = path.join('docs', 'demo.tape');
    if (exists(tapeRel)) {
      expect('demo tape label', read(tapeRel).split(`Label v${old}`).length - 1 === 1);
    }
  } catch (error) {
    return fail(`pre-flight could not read a file: ${error.message}`);
  }
  if (preflight.length > 0) {
    return fail(`refusing a drifted tree — these do not hold ${old}: ${preflight.join(', ')}`);
  }

  // Each edit: [file, apply(text) -> new text | null when nothing to do].
  // A present file that holds no occurrence of the old version is an
  // error (drift) — except README's rev snippet, which a repo may not
  // have at all; that case is caught by the self-check instead.
  const changed = [];
  const editFile = (rel, apply, { required = true } = {}) => {
    if (!exists(rel)) return;
    const before = read(rel);
    const after = apply(before);
    if (after === null) {
      if (required) throw new Error(`${rel}: no ${old} version mention found`);
      return;
    }
    if (after !== before) {
      write(rel, after);
      changed.push(rel);
    }
  };

  try {
    editFile('package.json', (text) => {
      if (countVersionFields(text, old) !== 1) return null;
      return replaceVersionField(text, old, version);
    });
    editFile('package-lock.json', (text) => {
      if (countVersionFields(text, old) < 1) return null;
      return replaceVersionField(text, old, version);
    });
    editFile('server.json', (text) => {
      if (countVersionFields(text, old) < 1) return null;
      return replaceVersionField(text, old, version);
    });
    editFile(path.join('.claude-plugin', 'marketplace.json'), (text) => {
      if (countVersionFields(text, old) !== 1) return null;
      return replaceVersionField(text, old, version);
    });
    editFile('.pre-commit-hooks.yaml', (text) => {
      if (!text.includes(`${name}@${old}`) || !text.includes(`rev: v${old}`)) return null;
      return replaceAll(replaceAll(text, `${name}@${old}`, `${name}@${version}`),
        `rev: v${old}`, `rev: v${version}`);
    });
    editFile('README.md', (text) => {
      if (text.split(`rev: v${old}`).length - 1 < 1) return null;
      return replaceAll(text, `rev: v${old}`, `rev: v${version}`);
    }, { required: false });
    editFile(path.join('docs', 'demo.tape'), (text) => {
      if (text.split(`Label v${old}`).length - 1 !== 1) return null;
      return replaceAll(text, `Label v${old}`, `Label v${version}`);
    });
    editFile('CHANGELOG.md', (text) => {
      if (!text.includes('## Unreleased')) {
        process.stderr.write('bump-version: warning: CHANGELOG has no ## Unreleased section — left unchanged\n');
        return text;
      }
      return text.replace('## Unreleased', `## ${version} — ${date}`);
    });
  } catch (error) {
    return fail(error.message);
  }

  // Self-check: re-read every version mention; all must equal the new
  // version, or the tree is half-bumped and the run fails loudly.
  const problems = [];
  const check = (label, ok) => { if (!ok) problems.push(label); };
  try {
    const pkgAfter = JSON.parse(read('package.json'));
    check('package.json version', pkgAfter.version === version);
    if (exists('package-lock.json')) {
      const lock = JSON.parse(read('package-lock.json'));
      check('package-lock.json version', lock.version === version);
      check('package-lock.json packages[""].version', lock.packages?.['']?.version === version);
    }
    if (exists('server.json')) {
      const server = JSON.parse(read('server.json'));
      check('server.json version', server.version === version);
      check('server.json packages[0].version', server.packages?.[0]?.version === version);
    }
    if (exists(path.join('.claude-plugin', 'marketplace.json'))) {
      const market = JSON.parse(read(path.join('.claude-plugin', 'marketplace.json')));
      check('marketplace.json metadata.version', market.metadata?.version === version);
    }
    if (exists('.pre-commit-hooks.yaml')) {
      const manifest = read('.pre-commit-hooks.yaml');
      check('pre-commit pinned dependency', manifest.includes(`${name}@${version}`));
      check('pre-commit documented rev', manifest.includes(`rev: v${version}`));
    }
    if (exists('README.md')) {
      const revs = [...read('README.md').matchAll(/rev: v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
      check('README documented rev', revs.length === 0 || revs.every((v) => v === version));
    }
    if (exists(path.join('docs', 'demo.tape'))) {
      check('demo tape label', read(path.join('docs', 'demo.tape')).includes(`Label v${version}`));
    }
    if (exists('CHANGELOG.md')) {
      const log = read('CHANGELOG.md');
      if (log.includes('## Unreleased')) {
        check('CHANGELOG Unreleased renamed', log.includes(`## ${version} — ${date}`));
      }
    }
  } catch (error) {
    return fail(`self-check could not read a file: ${error.message}`);
  }
  if (problems.length > 0) {
    return fail(`half-bumped tree — these still disagree with ${version}: ${problems.join(', ')}`);
  }

  process.stdout.write(`bump-version: ${old} → ${version} (${date})\n`);
  for (const rel of changed) process.stdout.write(`  updated ${rel}\n`);
  if (!changed.includes('CHANGELOG.md')) {
    process.stdout.write('  CHANGELOG.md unchanged (no ## Unreleased section)\n');
  }
  return 0;
}

// Compare resolved filesystem paths, not URL strings: on Windows
// process.argv[1] is a drive-letter path (C:\...) while import.meta.url
// is a file:// URL, so `import.meta.url === 'file://' + argv[1]` never
// matches there and the script silently does nothing — exit 0, no
// output, no files changed (the 2026-11-15 Windows CI failures).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
