/**
 * MCP server mode: `ci-triage --mcp`.
 *
 * A stdio MCP server in the standard library only — the same code
 * the CLI runs, served over JSON-RPC 2.0, one message per line.
 * Agents connect with the usual config:
 *
 *   { "mcpServers": { "ci-triage": { "command": "ci-triage", "args": ["--mcp"] } } }
 *
 * Protocol: `initialize` (2024-11-05), `notifications/initialized`,
 * `tools/list`, `tools/call`, `ping`. Each tool returns the same JSON
 * the CLI's --json output produces, so an agent that already knows
 * the CLI output knows the tool output too.
 *
 * Tools:
 *   triage_repo — triage a repo's recent failed CI runs.
 *   triage_log  — triage one pasted job log (no network).
 */
import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './errors.mjs';
import { triageLogText, triageRepo } from './triage.mjs';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'triage_repo',
    description: 'Triage a repo\'s recent failed GitHub Actions runs: fetch the failed runs, pull the failed job logs, group failures by root cause, and classify each as a test failure, build failure, infra failure, or flaky. Returns a ranked report with evidence lines. Note: GitHub does not allow anonymous job-log downloads, so this tool needs GH_TOKEN (or a logged-in gh CLI) to read logs; without one it lists the failed runs and jobs but reports that the logs are unreadable.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository as owner/repo, for example "facebook/react".' },
        runs: { type: 'integer', description: 'How many failed runs to examine (default 10, max 30).' },
        workflow: { type: 'string', description: 'Only this workflow (file name or id).' },
        branch: { type: 'string', description: 'Only this branch.' },
        top: { type: 'integer', description: 'Show only the N highest-ranked root causes.' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'triage_log',
    description: 'Triage one pasted CI job log (no network): extract the error signature and classify it as a test failure, build failure, infra failure, or unknown. Flakiness needs run history, so a single log always reports flaky: false.',
    inputSchema: {
      type: 'object',
      properties: {
        log: { type: 'string', description: 'The job log text.' },
        label: { type: 'string', description: 'Label for the log, for example the job name.' },
      },
      required: ['log'],
    },
  },
];

function textResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: false };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function callTool(name, args) {
  const input = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'triage_repo': {
      if (!input.repo) throw new UsageError('triage_repo needs a repo (owner/repo)');
      const result = await triageRepo(input.repo, {
        runs: input.runs ?? undefined,
        workflow: input.workflow,
        branch: input.branch,
      });
      if (input.top != null) {
        return textResult({ ...result, clusters: result.clusters.slice(0, input.top) });
      }
      return textResult(result);
    }
    case 'triage_log': {
      if (!input.log) throw new UsageError('triage_log needs a log');
      return textResult(triageLogText(input.log, { label: input.label || '' }));
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function handleMessage(message, version) {
  if (message == null || typeof message !== 'object' || Array.isArray(message)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const { method, id, params } = message;
  const isNotification = id === undefined;
  if (typeof method !== 'string') {
    return isNotification ? null : { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (method.startsWith('notifications/')) return null;
  if (isNotification) return null;

  const respond = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });

  try {
    switch (method) {
      case 'initialize':
        return respond({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'ci-triage', version },
        });
      case 'ping':
        return respond({});
      case 'tools/list':
        return respond({ tools: TOOLS });
      case 'tools/call': {
        if (!params || typeof params.name !== 'string') return fail(-32602, 'tools/call needs a tool name');
        return callTool(params.name, params.arguments)
          .then(respond)
          .catch((error) => respond(errorResult(error.message)));
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (error) {
    return fail(-32603, error.message);
  }
}

/**
 * Serve MCP over stdio until stdin closes. One JSON message per line;
 * a malformed line gets a -32700 parse error and the server keeps
 * going. Resolves when stdin ends; never throws for a bad message.
 *
 * Note: handleMessage returns a promise for tools/call (the triage
 * hits the network), so the data handler awaits it before writing.
 */
export function runMcpServer(options = {}) {
  const version = options.version || '0.1.0';
  let buffer = '';
  const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.trim() === '') {
        newline = buffer.indexOf('\n');
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        newline = buffer.indexOf('\n');
        continue;
      }
      const response = await handleMessage(message, version);
      if (response) write(response);
      newline = buffer.indexOf('\n');
    }
  });
  return new Promise((resolve) => {
    process.stdin.on('end', resolve);
    process.stdin.resume();
  });
}
