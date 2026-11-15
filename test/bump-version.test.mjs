import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../scripts/support.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'bump-version.mjs');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const OLD = pkg.version;
const NEW = '9.9.9';
const DATE = '2026-11-15';

// A miniature copy of the repo's version mentions: the same files the
// script edits, at the repo's current version. The optional files
// (pre-commit manifest, demo tape, README rev) are included by default
// and omitted by the minimal-shape test — the script must work in both
// repos, and ci-triage's real tree has none of them.
function writeFixture(dir, { withExtras = true, withUnreleased = true, readmeRev = OLD, minifiedPackageJson = false } = {}) {
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'),
    minifiedPackageJson
      ? JSON.stringify({ name: pkg.name, version: OLD })
      : JSON.stringify({ name: pkg.name, version: OLD }, null, 2));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    name: pkg.name, version: OLD, lockfileVersion: 3,
    packages: { '': { name: pkg.name, version: OLD } },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({
    name: `io.github.WJDdidi-1/${pkg.name.replace('-cli', '')}`,
    version: OLD,
    packages: [{ identifier: pkg.name, version: OLD }],
  }));
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    metadata: { version: OLD },
  }, null, 2));
  if (withExtras) {
    fs.writeFileSync(path.join(dir, '.pre-commit-hooks.yaml'),
      `#     rev: v${OLD}\n- id: x\n  additional_dependencies: ['${pkg.name}@${OLD}']\n`);
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'demo.tape'), `Label v${OLD}\nOutput docs/demo.gif\n`);
    fs.writeFileSync(path.join(dir, 'README.md'), `rev: v${readmeRev}\n`);
  }
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'),
    withUnreleased
      ? `# Changelog\n\n## Unreleased\n\n- New: something.\n\n## ${OLD} — 2026-11-14\n\n- Old: fixed in ${OLD}, kept as history.\n`
      : `# Changelog\n\n## ${OLD} — 2026-11-14\n\n- Old: fixed in ${OLD}, kept as history.\n`);
}

function run(dir, args = [NEW, '--date', DATE, '--root', dir]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function readJson(dir, rel) {
  return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
}

test('bump-version: moves every version mention and renames Unreleased', () => {
  const dir = tempDir('bump-version-full-');
  writeFixture(dir);
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${OLD} → ${NEW}`));
  assert.equal(readJson(dir, 'package.json').version, NEW);
  const lock = readJson(dir, 'package-lock.json');
  assert.equal(lock.version, NEW);
  assert.equal(lock.packages[''].version, NEW);
  const server = readJson(dir, 'server.json');
  assert.equal(server.version, NEW);
  assert.equal(server.packages[0].version, NEW);
  assert.equal(readJson(dir, '.claude-plugin/marketplace.json').metadata.version, NEW);
  const manifest = fs.readFileSync(path.join(dir, '.pre-commit-hooks.yaml'), 'utf8');
  assert.ok(manifest.includes(`${pkg.name}@${NEW}`));
  assert.ok(manifest.includes(`rev: v${NEW}`));
  assert.ok(fs.readFileSync(path.join(dir, 'README.md'), 'utf8').includes(`rev: v${NEW}`));
  assert.ok(fs.readFileSync(path.join(dir, 'docs', 'demo.tape'), 'utf8').includes(`Label v${NEW}`));
  const log = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  assert.ok(log.includes(`## ${NEW} — ${DATE}`));
  assert.ok(!log.includes('## Unreleased'));
  // History is untouched: the old version still appears as prose.
  assert.ok(log.includes(`fixed in ${OLD}`));
});

test('bump-version: works without the optional files (the other repo\'s shape)', () => {
  const dir = tempDir('bump-version-minimal-');
  writeFixture(dir, { withExtras: false });
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(dir, 'package.json').version, NEW);
  assert.equal(readJson(dir, 'server.json').version, NEW);
  assert.equal(readJson(dir, '.claude-plugin/marketplace.json').metadata.version, NEW);
  assert.ok(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8').includes(`## ${NEW} — ${DATE}`));
});

test('bump-version: handles a minified package.json (no space after the colon)', () => {
  // ci-triage's real package.json is one minified line
  // (`"version":"0.1.1"`); a spaced-only match would refuse its tree.
  const dir = tempDir('bump-version-minified-');
  writeFixture(dir, { withExtras: false, minifiedPackageJson: true });
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  const text = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  assert.equal(JSON.parse(text).version, NEW);
  // The bump preserves the file's spacing: still one line, no added space.
  assert.ok(!text.includes('\n'), 'minified package.json stays one line');
  assert.ok(text.includes(`"version":"${NEW}"`));
});

test('bump-version: no Unreleased section warns but still bumps', () => {
  const dir = tempDir('bump-version-no-unreleased-');
  writeFixture(dir, { withUnreleased: false });
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no ## Unreleased section/);
  assert.equal(readJson(dir, 'package.json').version, NEW);
  assert.ok(!fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8').includes(`## ${NEW} —`));
});

test('bump-version: an invalid version fails and writes nothing', () => {
  const dir = tempDir('bump-version-invalid-');
  writeFixture(dir);
  const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  const result = run(dir, ['1.2', '--date', DATE, '--root', dir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a plain x\.y\.z version/);
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before);
});

test('bump-version: a missing version fails with usage', () => {
  const dir = tempDir('bump-version-missing-');
  writeFixture(dir);
  const result = run(dir, ['--root', dir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing <new-version>/);
});

test('bump-version: bumping to the current version is a no-op', () => {
  const dir = tempDir('bump-version-noop-');
  writeFixture(dir);
  const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  const result = run(dir, [OLD, '--date', DATE, '--root', dir]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already at/);
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before);
  assert.ok(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8').includes('## Unreleased'));
});

test('bump-version: a stale README rev refuses the tree before writing anything', () => {
  const dir = tempDir('bump-version-stale-');
  writeFixture(dir, { readmeRev: '0.0.1' });
  const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  const result = run(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing a drifted tree/);
  assert.match(result.stderr, /README documented rev/);
  // Nothing was written: the pre-flight runs before any edit.
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before);
});
