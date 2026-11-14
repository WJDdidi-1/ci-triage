import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateCompletion, GLOBAL_OPTIONS, knownCommands, knownOptions } from '../lib/completion.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ci-triage.js');

function run(args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
}

// Drive the generated bash function the way bash does: source the
// script, set COMP_WORDS / COMP_CWORD, call the function, read
// COMPREPLY. This is a real completion, not a string match.
function bashComplete(words, cword) {
  const script = generateCompletion('bash');
  const quoted = words.map((word) => `'${word}'`).join(' ');
  const probe = `${script}\nCOMP_WORDS=(${quoted})\nCOMP_CWORD=${cword}\nCOMPREPLY=()\n_ci_triage\nprintf '%s\\n' "\${COMPREPLY[@]}"\n`;
  const result = spawnSync('bash', ['--norc', '-c', probe], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n').filter(Boolean);
}

function syntaxCheck(shell, command) {
  const script = generateCompletion(shell);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-triage-completion-')), `ci-triage.${shell}`);
  fs.writeFileSync(file, script, 'utf8');
  const result = spawnSync(command, ['-n', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return script;
}

test('completion: spec is the single source of truth — every option the parser knows', () => {
  // The bin derives KNOWN_OPTIONS from this spec, so the spec and
  // the parser cannot drift by construction. What can drift is the
  // spec against --help, which is written by hand next to the
  // parser: check both directions.
  const help = run(['--help']);
  assert.equal(help.status, 0);
  for (const option of knownOptions()) {
    assert.ok(help.stdout.includes(option), `option ${option} missing from --help`);
  }
  const mentioned = new Set([
    ...help.stdout.matchAll(/--[a-z][a-z-]*/g),
    ...help.stdout.matchAll(/(?<![a-zA-Z0-9-])-[a-z](?![a-zA-Z0-9-])/g),
  ].map((match) => match[0]));
  for (const option of mentioned) {
    assert.ok(knownOptions().includes(option), `option ${option} is in --help but not in the completion spec`);
  }
  assert.deepEqual(knownCommands(), ['completion', 'doctor']);
});

test('completion: every shell script names the completion command and every option', () => {
  for (const shell of ['bash', 'zsh', 'fish']) {
    const script = generateCompletion(shell);
    assert.equal(typeof script, 'string');
    assert.ok(script.includes('completion'), `${shell} script is missing the completion command`);
    assert.ok(script.includes('doctor'), `${shell} script is missing the doctor command`);
    for (const option of knownOptions()) {
      // Fish writes long options as `-l name` and short ones as
      // `-s x`, so the check is on the bare name there.
      const needle = shell === 'fish' ? option.replace(/^-+/, '') : option;
      assert.ok(script.includes(needle), `${shell} script is missing option ${option}`);
    }
    assert.ok(script.includes('bash'), `${shell} script does not complete the shell names`);
    assert.ok(script.includes('zsh'), `${shell} script does not complete the shell names`);
    assert.ok(script.includes('fish'), `${shell} script does not complete the shell names`);
  }
  assert.equal(generateCompletion('powershell'), null);
  assert.equal(generateCompletion(''), null);
});

test('completion: bash and zsh scripts pass their shell syntax check', () => {
  syntaxCheck('bash', 'bash');
  syntaxCheck('zsh', 'zsh');
  // No fish installed here, so the fish script is verified by the
  // content assertions above and by the CLI tests below.
});

test('completion: bash completes options and the completion command', () => {
  const opts = bashComplete(['ci-triage', '--'], 1);
  assert.ok(opts.includes('--workflow'));
  assert.ok(opts.includes('--runs'));
  assert.ok(opts.includes('--json'));
  assert.ok(!opts.includes('completion'), 'typing -- must only offer options');
  const first = bashComplete(['ci-triage', ''], 1);
  assert.ok(first.includes('completion'));
  assert.ok(first.includes('doctor'));
  assert.ok(first.includes('--workflow'));
  assert.deepEqual(bashComplete(['ci-triage', 'completion', 'z'], 2), ['zsh']);
  assert.deepEqual(bashComplete(['ci-triage', 'completion', ''], 2).sort(), ['bash', 'fish', 'zsh']);
});

test('completion: bash offers filenames, not options, after a value-taking option', () => {
  // After --report the function returns with COMPREPLY empty, so
  // bash falls back to its default (filename) completion via
  // -o default.
  assert.deepEqual(bashComplete(['ci-triage', '--report', ''], 2), []);
});

test('completion: CLI prints the script, and bad shells are usage errors', () => {
  const bash = run(['completion', 'bash']);
  assert.equal(bash.status, 0);
  assert.match(bash.stdout, /_ci_triage/);
  assert.match(bash.stdout, /complete -o default -F _ci_triage ci-triage/);
  const zsh = run(['completion', 'zsh']);
  assert.equal(zsh.status, 0);
  assert.match(zsh.stdout, /#compdef ci-triage/);
  const fish = run(['completion', 'fish']);
  assert.equal(fish.status, 0);
  assert.match(fish.stdout, /complete -c ci-triage/);

  const missing = run(['completion']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /completion needs a shell: bash, zsh or fish/);
  const unknown = run(['completion', 'powershell']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown shell: powershell/);
  const extra = run(['completion', 'bash', 'zsh']);
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /unexpected argument: zsh/);
});

test('completion: --help lists the completion command', () => {
  const help = run(['--help']);
  assert.match(help.stdout, /completion <bash\|zsh\|fish>/);
});
