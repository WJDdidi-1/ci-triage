import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { generateSkill, skillPath, SKILL_MD, ensureAgentsSection, AGENTS_SECTION } from '../lib/skill.mjs';
import { tempDir } from '../scripts/support.mjs';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ci-triage.js');

test('skill: --skill-generate writes a SKILL.md in the project', () => {
  const dir = tempDir('ci-triage-skill-');
  const out = generateSkill('project', dir);
  assert.equal(out.created, true);
  assert.equal(out.path, path.join(dir, '.claude', 'skills', 'ci-triage', 'SKILL.md'));
  const content = fs.readFileSync(out.path, 'utf8');
  assert.ok(content.includes('ci-triage'));
  assert.ok(content.includes('owner/repo'));
  assert.equal(content, SKILL_MD);
});

test('skill: generation refuses to overwrite an existing file', () => {
  const dir = tempDir('ci-triage-skill-');
  const first = generateSkill('project', dir);
  assert.equal(first.created, true);
  const second = generateSkill('project', dir);
  assert.equal(second.created, false);
  assert.match(second.reason, /already exists/);
  // The user's file is untouched.
  assert.equal(fs.readFileSync(first.path, 'utf8'), SKILL_MD);
});

test('skill: global scope writes under $HOME', () => {
  const home = tempDir('ci-triage-home-');
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(skillPath('global'), path.join(home, '.claude', 'skills', 'ci-triage', 'SKILL.md'));
    const out = generateSkill('global');
    assert.equal(out.created, true);
    assert.ok(fs.existsSync(out.path));
  } finally {
    process.env.HOME = oldHome;
  }
});

test('skill: ensureAgentsSection creates AGENTS.md when missing', () => {
  const dir = tempDir('ci-triage-agents-');
  const out = ensureAgentsSection('project', dir);
  assert.equal(out.status, 'created');
  assert.equal(out.path, path.join(dir, 'AGENTS.md'));
  assert.equal(fs.readFileSync(out.path, 'utf8'), AGENTS_SECTION);
  assert.ok(fs.readFileSync(out.path, 'utf8').includes('ci-triage <owner/repo>'));
  assert.ok(fs.readFileSync(out.path, 'utf8').includes('--json'));
  assert.ok(fs.readFileSync(out.path, 'utf8').includes('https://github.com/WJDdidi-1/ci-triage'));
});

test('skill: ensureAgentsSection appends without touching existing content', () => {
  const dir = tempDir('ci-triage-agents-append-');
  const target = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(target, '# My repo rules\n');
  const out = ensureAgentsSection('project', dir);
  assert.equal(out.status, 'appended');
  const content = fs.readFileSync(target, 'utf8');
  assert.ok(content.startsWith('# My repo rules\n'));
  assert.ok(content.includes('## ci-triage'));
});

test('skill: ensureAgentsSection is idempotent on a second call', () => {
  const dir = tempDir('ci-triage-agents-twice-');
  const first = ensureAgentsSection('project', dir);
  assert.equal(first.status, 'created');
  const before = fs.readFileSync(first.path, 'utf8');
  const second = ensureAgentsSection('project', dir);
  assert.equal(second.status, 'already-present');
  assert.equal(fs.readFileSync(first.path, 'utf8'), before);
});

test('skill: ensureAgentsSection skips in global scope', () => {
  const dir = tempDir('ci-triage-agents-global-');
  const out = ensureAgentsSection('global', dir);
  assert.equal(out.status, 'skipped');
  assert.equal(out.path, null);
  assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')));
});

test('skill: --skill-generate writes both SKILL.md and AGENTS.md', () => {
  const dir = tempDir('ci-triage-skill-cli-');
  const result = spawnSync(process.execPath, [bin, '--skill-generate'], { encoding: 'utf8', cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'ci-triage', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')));
  assert.match(result.stdout, /Wrote .*AGENTS\.md/);
  assert.match(result.stdout, /Wrote .*SKILL\.md/);
});
