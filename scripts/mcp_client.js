#!/usr/bin/env node

// Minimal MCP stdio client CLI
// Usage:
//   node scripts/mcp_client.js --tool <name> --args '{"key":"value"}'
// Optional:
//   --cwd <path>  # working directory for the server (isolates data/)

import path from 'path';
import fs from 'fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tool') {
      args.tool = argv[++i];
    } else if (arg === '--args') {
      args.args = argv[++i];
    } else if (arg === '--cwd') {
      args.cwd = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printUsage() {
  console.error('Usage: node scripts/mcp_client.js --tool <name> --args "<json>" [--cwd <path>]');
}

async function main() {
  const { tool, args: argsJson, cwd, help } = parseArgs(process.argv);
  if (help) {
    printUsage();
    process.exit(0);
  }

  if (!tool) {
    console.error('Error: --tool is required');
    printUsage();
    process.exit(1);
  }

  let parsedArgs = {};
  if (argsJson) {
    try {
      parsedArgs = JSON.parse(argsJson);
    } catch (e) {
      console.error('Error: --args must be valid JSON');
      console.error(String(e));
      process.exit(1);
    }
  }

  const projectRoot = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
  const serverPath = path.join(projectRoot, 'src', 'server.js');

  if (!fs.existsSync(serverPath)) {
    console.error(`Error: MCP server not found at ${serverPath}`);
    process.exit(1);
  }

  const workingDir = cwd ? path.resolve(cwd) : projectRoot;

  // Ensure data directory exists in working dir
  const dataDir = path.join(workingDir, 'data');
  if (!fs.existsSync(dataDir)) {
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
  }

  const client = new Client({ name: 'todo-mcp-client', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    cwd: workingDir,
    env: process.env,
  });

  try {
    await client.connect(transport);

    // Optionally verify tool exists
    try {
      const toolsResp = await client.listTools();
      const toolNames = (toolsResp?.tools || []).map(t => t.name);
      if (!toolNames.includes(tool)) {
        console.error(`Error: Tool '${tool}' not found. Available tools: ${toolNames.join(', ')}`);
        process.exit(2);
      }
    } catch {
      // Continue even if listing tools fails; call might still work
    }

    // Apply per-call timeout and one retry on timeout/error
    async function callWithTimeout() {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15000);
      try {
        return await client.callTool({ name: tool, arguments: parsedArgs, signal: controller.signal });
      } finally {
        clearTimeout(t);
      }
    }
    async function callWithRetry() {
      try {
        return await callWithTimeout();
      } catch (err) {
        // Retry once on abort/timeout or transient error
        return await callWithTimeout();
      }
    }
    const callResp = await callWithRetry();
    // Print content payloads as JSON
    const out = {
      tool,
      arguments: parsedArgs,
      response: callResp,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } catch (err) {
    console.error('MCP client error:', err?.message || String(err));
    process.exit(1);
  } finally {
    try { await client.close?.(); } catch {}
  }
}

main();


