import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const bin = path.join(root, 'bin', 'ci-triage.js');

// The MCPB bundle (modelcontextprotocol/mcpb, the renamed DXT format)
// is the one-click install path for Claude Desktop: a manifest.json
// plus the server code, packed with `mcpb pack` into a .mcpb file the
// user drags onto Settings → Extensions. These tests pin the manifest
// against the package and against the live server, so a version bump
// or a tool rename that forgets the manifest fails the suite instead
// of shipping a bundle that installs the wrong version or lists tools
// the server does not have. The manifest itself was validated against
// the official v0.3 schema offline (ajv) and packed with the official
// toolchain — see the run log — because the suite has no schema
// dependency and no Claude Desktop to install into.

test('mcpb: manifest fields agree with package.json and the entry point exists', () => {
  assert.equal(manifest.manifest_version, '0.3');
  assert.equal(manifest.name, 'ci-triage');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.description, pkg.description);
  assert.equal(manifest.license, pkg.license);
  assert.equal(manifest.author.name, 'WJDdidi-1');
  // package.json records the URL as git+https://…; the manifest
  // carries the plain https URL the directory shows.
  assert.equal(manifest.repository.url, pkg.repository.url.replace(/^git\+/, ''));
  assert.equal(manifest.server.type, 'node');
  assert.equal(manifest.server.entry_point, 'bin/ci-triage.js');
  assert.ok(fs.existsSync(path.join(root, manifest.server.entry_point)), 'entry point must exist in the repo');
  assert.equal(manifest.server.mcp_config.command, 'node');
  assert.deepEqual(manifest.server.mcp_config.args, ['${__dirname}/bin/ci-triage.js', '--mcp']);
  assert.ok(Array.isArray(manifest.compatibility.platforms) && manifest.compatibility.platforms.length === 3);
  assert.equal(manifest.compatibility.runtimes.node, '>=18.0.0');
});

test('mcpb: .mcpbignore keeps tests and tooling out of the bundle', () => {
  const ignore = fs.readFileSync(path.join(root, '.mcpbignore'), 'utf8');
  for (const entry of ['test/', '.github/', 'scripts/', 'skills/', '.claude-plugin/']) {
    assert.ok(ignore.split('\n').includes(entry), `.mcpbignore must exclude ${entry}`);
  }
  assert.doesNotMatch(ignore, /^bin\//m);
  assert.doesNotMatch(ignore, /^lib\//m);
});

// A minimal scripted MCP client: send the requests, close stdin, and
// read every response line until the server exits.
async function listMcp(requests) {
  const child = spawn(process.execPath, [bin, '--mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  requests.forEach((request, index) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: index + 2, ...request })}\n`);
  });
  child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 10000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
  const responses = out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const byId = new Map(responses.filter((r) => r.id != null).map((r) => [r.id, r.result]));
  return byId;
}

test('mcpb: the manifest lists exactly the tools and prompt the live server serves', async () => {
  const byId = await listMcp([
    { method: 'tools/list' },
    { method: 'prompts/list' },
    { method: 'prompts/get', params: { name: 'triage_ci', arguments: { repo: 'owner/repo' } } },
  ]);
  const liveTools = byId.get(2).tools;
  assert.deepEqual(
    liveTools.map((tool) => tool.name),
    manifest.tools.map((tool) => tool.name),
    'manifest tools must match tools/list in order',
  );
  for (const listed of manifest.tools) {
    const live = liveTools.find((tool) => tool.name === listed.name);
    assert.ok(live.description.startsWith(listed.description), `manifest description for ${listed.name} must be the start of the live description`);
  }
  const livePrompts = byId.get(3).prompts;
  assert.deepEqual(
    livePrompts.map((prompt) => prompt.name),
    manifest.prompts.map((prompt) => prompt.name),
  );
  assert.deepEqual(livePrompts[0].arguments.map((arg) => arg.name), manifest.prompts[0].arguments);
  // The manifest prompt text is the render template: substitute the
  // arguments the same way the host would and it must equal what the
  // server renders for those arguments.
  const rendered = byId.get(4).messages[0].content.text;
  const templated = manifest.prompts[0].text.replaceAll('${arguments.repo}', 'owner/repo');
  assert.equal(rendered, templated);
});
