// Pre-publish check for the MCP registry release job
// (.github/workflows/mcp-registry.yml).
//
// Verifies the npm package version named in server.json is live on the
// public registry and carries the matching mcpName, and reports the
// registry's current listing. Exits non-zero on any failure so the
// workflow stops before mcp-publisher runs. No dependencies, Node >= 18.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const server = JSON.parse(readFileSync(path.join(root, 'server.json'), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  return res.json();
}

const version = server.version;
const identifier = server.packages[0].identifier;

if (version !== pkg.version) {
  console.error(`FAIL server.json is ${version}, package.json is ${pkg.version}: bump server.json before publishing`);
  process.exit(1);
}

// npm metadata lags the publish by a few minutes; poll for up to 10 minutes.
let published = null;
for (let attempt = 1; attempt <= 20; attempt++) {
  published = await fetchJson(`https://registry.npmjs.org/${identifier}/${version}`);
  if (published) break;
  console.log(`info ${identifier}@${version} not on npm yet (attempt ${attempt}/20), waiting 30s...`);
  await sleep(30000);
}
if (!published) {
  console.error(`FAIL ${identifier}@${version} is not on npm: publish the package before the server`);
  process.exit(1);
}
if (published.mcpName !== server.name) {
  console.error(`FAIL ${identifier}@${version} carries mcpName ${published.mcpName ?? '(none)'}, server.json says ${server.name}`);
  process.exit(1);
}
console.log(`ok ${identifier}@${version} is on npm with mcpName ${server.name}`);

const encoded = encodeURIComponent(server.name);
const current = await fetchJson(`https://registry.modelcontextprotocol.io/v0.1/servers/${encoded}/versions/latest`);
if (current?.server?.version) {
  console.log(`info the registry lists ${current.server.version}, this release is ${version}: publish moves it`);
} else {
  console.log('info the registry has no listing for this server yet: publish creates it');
}
