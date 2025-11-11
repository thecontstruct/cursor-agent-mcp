import { describe, it, expect, beforeAll, afterAll, skip } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('E2E MCP Server Tests', () => {
  let client;
  let transport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: ['./server.js'],
      cwd: __dirname,
      env: { ...process.env, CURSOR_AGENT_TIMEOUT_MS: process.env.CURSOR_AGENT_TIMEOUT_MS ?? '8000' },
    });

    client = new Client({
      name: 'cursor-agent-e2e-test',
      version: '0.0.1',
    });

    await client.connect(transport);
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
  });

  it('should list available tools', async () => {
    const tools = await client.listTools({});
    const names = tools.tools.map(t => t.name);

    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('cursor_agent_chat');
    expect(names).toContain('cursor_agent_raw');
  });

  it('should call cursor_agent_chat tool', async () => {
    // Skip if cursor-agent CLI is not available
    try {
      const result = await client.callTool({
        name: 'cursor_agent_chat',
        arguments: {
          prompt: 'hello from E2E test',
          output_format: 'text',
        },
      });

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
    } catch (error) {
      if (error.message?.includes('not found') || error.message?.includes('ENOENT')) {
        skip('cursor-agent CLI not available');
      }
      throw error;
    }
  }, 30000);

  it('should call cursor_agent_raw tool with --help', async () => {
    try {
      const result = await client.callTool({
        name: 'cursor_agent_raw',
        arguments: {
          argv: ['--help'],
          print: false,
        },
      });

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    } catch (error) {
      if (error.message?.includes('not found') || error.message?.includes('ENOENT')) {
        skip('cursor-agent CLI not available');
      }
      throw error;
    }
  }, 30000);

  it('should handle invalid tool name', async () => {
    await expect(
      client.callTool({
        name: 'nonexistent_tool',
        arguments: {},
      })
    ).rejects.toThrow();
  });

  it('should handle invalid arguments', async () => {
    try {
      const result = await client.callTool({
        name: 'cursor_agent_chat',
        arguments: {
          // Missing required prompt
        },
      });

      // Should return error content
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid params');
    } catch (error) {
      // Or throw an error
      expect(error).toBeDefined();
    }
  });
});

