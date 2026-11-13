import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { generateSkill, skillPath, SKILL_MD } from '../lib/skill.mjs';
import { tempDir } from '../scripts/support.mjs';

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
