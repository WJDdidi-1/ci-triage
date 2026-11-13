import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const server = JSON.parse(readFileSync(path.join(root, 'server.json'), 'utf8'));

test('registry: package.json and server.json agree on name and version', () => {
  assert.equal(pkg.mcpName, server.name);
  assert.equal(pkg.version, server.version);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].registryType, 'npm');
  assert.equal(server.packages[0].transport.type, 'stdio');
  assert.equal(server.repository.url, 'https://github.com/WJDdidi-1/ci-triage');
});

test('registry: server description fits the 100-character limit', () => {
  assert.ok(server.description.length <= 100, `description is ${server.description.length} chars`);
});

test('registry: mcpName is the io.github namespace for this repo', () => {
  assert.equal(pkg.mcpName, 'io.github.WJDdidi-1/ci-triage');
});
