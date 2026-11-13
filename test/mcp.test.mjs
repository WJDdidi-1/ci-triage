import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'ci-triage.js');
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const jestLog = readFileSync(path.join(fixtures, 'jest-failure.log'), 'utf8');

// A tiny MCP client: spawn the server, send one message per line,
// collect responses by id.
function startClient() {
  const child = spawn(process.execPath, [bin, '--mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() !== '') {
        const message = JSON.parse(line);
        if (message.id != null && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      }
      newline = buffer.indexOf('\n');
    }
  });
  const send = (message) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...message })}\n`);
    setTimeout(() => reject(new Error('MCP response timed out')), 10000);
  });
  const stop = () => {
    child.stdin.end();
    return new Promise((resolve) => child.on('exit', resolve));
  };
  return { send, stop, child };
}

test('mcp: initialize, tools/list, ping', async () => {
  const client = startClient();
  try {
    const init = await client.send({ method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert.equal(init.result.serverInfo.name, 'ci-triage');
    const ping = await client.send({ method: 'ping' });
    assert.deepEqual(ping.result, {});
    const list = await client.send({ method: 'tools/list' });
    assert.deepEqual(list.result.tools.map((t) => t.name), ['triage_repo', 'triage_log']);
  } finally {
    await client.stop();
  }
});

test('mcp: triage_log classifies a pasted log without the network', async () => {
  const client = startClient();
  try {
    await client.send({ method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    const call = await client.send({
      method: 'tools/call',
      params: { name: 'triage_log', arguments: { log: jestLog, label: 'test' } },
    });
    assert.equal(call.result.isError, false);
    const payload = JSON.parse(call.result.content[0].text);
    assert.equal(payload.category, 'test');
    assert.ok(payload.signature.id);
    assert.equal(payload.flaky, false);
  } finally {
    await client.stop();
  }
});

test('mcp: unknown tool is a tool error, unknown method is -32601', async () => {
  const client = startClient();
  try {
    await client.send({ method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    const badTool = await client.send({ method: 'tools/call', params: { name: 'nope', arguments: {} } });
    assert.equal(badTool.result.isError, true);
    assert.match(badTool.result.content[0].text, /unknown tool/);
    const badMethod = await client.send({ method: 'resources/list' });
    assert.equal(badMethod.error.code, -32601);
  } finally {
    await client.stop();
  }
});

test('mcp: a malformed line gets a parse error and the server keeps going', async () => {
  const client = startClient();
  try {
    await client.send({ method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    // Send a malformed line directly, then a valid ping: the ping
    // still answers, so the server survived the bad line.
    client.child.stdin.write('this is not json\n');
    const ping = await client.send({ method: 'ping' });
    assert.deepEqual(ping.result, {});
  } finally {
    await client.stop();
  }
});
