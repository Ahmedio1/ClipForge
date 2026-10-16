#!/usr/bin/env node
// stdio bridge for AI apps that launch MCP servers as a command (e.g. Claude Desktop):
// forwards tool calls to the running ClipForge (CLIPFORGE_URL, default http://127.0.0.1:4317).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../server/mcp.js';

const server = createMcpServer(process.env.CLIPFORGE_URL || 'http://127.0.0.1:4317');
await server.connect(new StdioServerTransport());
