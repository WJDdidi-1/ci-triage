import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SKILL_DIR_NAME, SKILL_MD, validateSkillMd } from '../lib/skill.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const marketplace = JSON.parse(readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));

// Claude Code plugin marketplace (the method is anthropics/skills):
// a marketplace is a git repo with .claude-plugin/marketplace.json;
// each plugin lists the skills it ships, and users install with
// `/plugin marketplace add <owner>/<repo>` then
// `/plugin install <plugin>@<marketplace>` — no CLI install needed
// first, because the skill itself falls back to npx. These tests pin
// the invariants so a rename, a stale version, or a drifted skill
// file fails CI instead of shipping a listing that installs nothing.

test('marketplace: marketplace.json has the required shape', () => {
  assert.equal(marketplace.name, 'ci-triage');
  assert.equal(typeof marketplace.owner?.name, 'string');
  assert.ok(marketplace.owner.name.length > 0, 'owner name must not be empty');
  assert.equal(marketplace.plugins.length, 1);
  const plugin = marketplace.plugins[0];
  assert.equal(plugin.name, SKILL_DIR_NAME);
  assert.equal(plugin.source, './');
  assert.equal(plugin.strict, false);
  assert.deepEqual(plugin.skills, [`./skills/${SKILL_DIR_NAME}`]);
  assert.ok(plugin.description.length > 0, 'plugin description must not be empty');
});

test('marketplace: metadata version matches the package version', () => {
  assert.equal(marketplace.metadata.version, pkg.version);
  assert.ok(marketplace.metadata.description.length > 0, 'metadata description must not be empty');
});

test('marketplace: every listed skill path exists', () => {
  for (const plugin of marketplace.plugins) {
    for (const skill of plugin.skills) {
      const skillMd = path.join(root, skill.replace(/^\.\//, ''), 'SKILL.md');
      assert.ok(existsSync(skillMd), `listed skill is missing: ${skill}/SKILL.md`);
    }
  }
});

test('marketplace: repo SKILL.md is byte-identical to the generator template', () => {
  const repoSkill = readFileSync(path.join(root, 'skills', SKILL_DIR_NAME, 'SKILL.md'), 'utf8');
  assert.equal(repoSkill, SKILL_MD);
});

test('marketplace: repo SKILL.md is valid per the Agent Skills spec', () => {
  const repoSkill = readFileSync(path.join(root, 'skills', SKILL_DIR_NAME, 'SKILL.md'), 'utf8');
  const result = validateSkillMd(repoSkill, SKILL_DIR_NAME);
  assert.equal(result.valid, true, (result.problems ?? []).join('; '));
});
