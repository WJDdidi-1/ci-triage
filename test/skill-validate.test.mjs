import assert from 'node:assert/strict';
import test from 'node:test';
import { SKILL_MD, SKILL_DIR_NAME, validateSkillMd } from '../lib/skill.mjs';

const valid = (overrides = {}) => {
  const name = overrides.name ?? 'ci-triage';
  const description = overrides.description ?? 'Triage red CI before reading any log.';
  const extra = overrides.extra ?? '';
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ci-triage\n`;
};

test('skill-validate: the SKILL.md we generate passes validation', () => {
  assert.deepEqual(validateSkillMd(SKILL_MD, SKILL_DIR_NAME), { valid: true });
});

test('skill-validate: a minimal valid file passes', () => {
  assert.deepEqual(validateSkillMd(valid(), 'ci-triage'), { valid: true });
});

test('skill-validate: optional keys are accepted', () => {
  const text = valid({ extra: 'license: Apache-2.0\ncompatibility: Claude Code\nallowed-tools: Read Bash\n' });
  assert.deepEqual(validateSkillMd(text, 'ci-triage'), { valid: true });
});

test('skill-validate: metadata block is accepted', () => {
  const text = valid({ extra: 'metadata:\n  version: "1"\n' });
  assert.deepEqual(validateSkillMd(text, 'ci-triage'), { valid: true });
});

test('skill-validate: missing frontmatter fails', () => {
  const result = validateSkillMd('# ci-triage\n', 'ci-triage');
  assert.equal(result.valid, false);
  assert.match(result.problems.join(' '), /missing frontmatter/);
});

test('skill-validate: unclosed frontmatter fails', () => {
  const result = validateSkillMd('---\nname: ci-triage\n', 'ci-triage');
  assert.equal(result.valid, false);
  assert.match(result.problems.join(' '), /never closes/);
});

test('skill-validate: a line that is not "key: value" fails', () => {
  const result = validateSkillMd('---\nname ci-triage\ndescription: x\n---\n\n# c\n', 'ci-triage');
  assert.equal(result.valid, false);
  assert.match(result.problems.join(' '), /not "key: value"/);
});

test('skill-validate: unknown keys and duplicates fail', () => {
  const unknown = validateSkillMd(valid({ extra: 'frobnicate: yes\n' }), 'ci-triage');
  assert.equal(unknown.valid, false);
  assert.match(unknown.problems.join(' '), /unknown frontmatter key "frobnicate"/);
  const duplicate = validateSkillMd('---\nname: ci-triage\nname: ci-triage\ndescription: x\n---\n\n# c\n', 'ci-triage');
  assert.equal(duplicate.valid, false);
  assert.match(duplicate.problems.join(' '), /duplicate frontmatter key "name"/);
});

test('skill-validate: missing name or description fails', () => {
  const noName = validateSkillMd('---\ndescription: x\n---\n\n# c\n', 'ci-triage');
  assert.match(noName.problems.join(' '), /missing "name"/);
  const noDescription = validateSkillMd('---\nname: ci-triage\n---\n\n# c\n', 'ci-triage');
  assert.match(noDescription.problems.join(' '), /missing "description"/);
});

test('skill-validate: name must be kebab-case and match the directory', () => {
  for (const name of ['Ci-Triage', '-ci-triage', 'ci-triage-', 'ci--triage', 'ci_triage', 'a'.repeat(65)]) {
    const result = validateSkillMd(valid({ name }), 'ci-triage');
    assert.equal(result.valid, false, name);
    assert.match(result.problems.join(' '), /name /);
  }
  // A valid kebab name that is simply not this skill's directory.
  const mismatch = validateSkillMd(valid({ name: 'other-skill' }), 'ci-triage');
  assert.equal(mismatch.valid, false);
  assert.match(mismatch.problems.join(' '), /does not match the skill directory "ci-triage"/);
});

test('skill-validate: description length and angle brackets', () => {
  const empty = validateSkillMd(valid({ description: '' }), 'ci-triage');
  assert.match(empty.problems.join(' '), /description must be 1-1024/);
  const long = validateSkillMd(valid({ description: 'x'.repeat(1025) }), 'ci-triage');
  assert.match(long.problems.join(' '), /description must be 1-1024/);
  const angled = validateSkillMd(valid({ description: 'Triage <this> CI.' }), 'ci-triage');
  assert.match(angled.problems.join(' '), /must not contain < or >/);
  const boundary = validateSkillMd(valid({ description: 'x'.repeat(1024) }), 'ci-triage');
  assert.deepEqual(boundary, { valid: true });
});

test('skill-validate: compatibility over 500 chars fails', () => {
  const result = validateSkillMd(valid({ extra: `compatibility: ${'x'.repeat(501)}\n` }), 'ci-triage');
  assert.equal(result.valid, false);
  assert.match(result.problems.join(' '), /compatibility must be at most 500/);
});

test('skill-validate: empty body fails', () => {
  const result = validateSkillMd('---\nname: ci-triage\ndescription: x\n---\n', 'ci-triage');
  assert.equal(result.valid, false);
  assert.match(result.problems.join(' '), /no body/);
});

test('skill-validate: all problems are reported, not just the first', () => {
  const result = validateSkillMd('---\nname: Bad_Name\ndescription: <x>\n---\n', 'ci-triage');
  assert.equal(result.valid, false);
  assert.ok(result.problems.length >= 3, result.problems.join('; '));
});
