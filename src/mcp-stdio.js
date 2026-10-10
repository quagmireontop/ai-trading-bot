#!/usr/bin/env node
// Local MCP server for Claude Desktop / Claude Code. See README "Connect Claude".
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './tools.js';

const server = createMcpServer();
await server.connect(new StdioServerTransport());
console.error('ai-trading-bot MCP server running on stdio');
