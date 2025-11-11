import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { invokeCursorAgent, runCursorAgent } from './server.js';
import { createMockChildProcess } from './test/utils.js';

// Mock child_process.spawn
vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(),
  };
});

describe('invokeCursorAgent', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment
    for (const key in process.env) {
      if (key.startsWith('CURSOR_AGENT_') || key === 'DEBUG_CURSOR_MCP') {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it('should spawn cursor-agent with correct arguments', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'test output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    await invokeCursorAgent({ argv: ['test prompt'], output_format: 'text' });

    expect(spawn).toHaveBeenCalledWith(
      'cursor-agent',
      expect.arrayContaining(['--print', '--output-format', 'text', 'test prompt']),
      expect.objectContaining({
        shell: false,
        cwd: expect.any(String),
        env: expect.any(Object),
      }),
    );
  });

  it('should handle different output formats', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'json output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    await invokeCursorAgent({ argv: ['test'], output_format: 'json' });

    expect(spawn).toHaveBeenCalledWith(
      'cursor-agent',
      expect.arrayContaining(['--output-format', 'json']),
      expect.any(Object),
    );
  });

  it('should include model flag when provided', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    await invokeCursorAgent({ argv: ['test'], model: 'gpt-4' });

    expect(spawn).toHaveBeenCalledWith(
      'cursor-agent',
      expect.arrayContaining(['-m', 'gpt-4']),
      expect.any(Object),
    );
  });

  it('should include force flag when provided', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    await invokeCursorAgent({ argv: ['test'], force: true });

    expect(spawn).toHaveBeenCalledWith(
      'cursor-agent',
      expect.arrayContaining(['-f']),
      expect.any(Object),
    );
  });

  it('should use model from environment when not provided in args', async () => {
    process.env.CURSOR_AGENT_MODEL = 'gpt-3.5-turbo';
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    await invokeCursorAgent({ argv: ['test'] });

    expect(spawn).toHaveBeenCalledWith(
      'cursor-agent',
      expect.arrayContaining(['-m', 'gpt-3.5-turbo']),
      expect.any(Object),
    );
  });

  it('should use force from environment when not provided in args', async () => {
    process.env.CURSOR_AGENT_FORCE = 'true';
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    await invokeCursorAgent({ argv: ['test'] });

    expect(spawn).toHaveBeenCalledWith(
      'cursor-agent',
      expect.arrayContaining(['-f']),
      expect.any(Object),
    );
  });

  it('should not add model flag if already present in argv', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    await invokeCursorAgent({ argv: ['-m', 'gpt-4', 'test'] });

    const callArgs = vi.mocked(spawn).mock.calls[0][1];
    const modelFlags = callArgs.filter((arg, i) => arg === '-m' || arg === '--model' || callArgs[i - 1] === '-m' || callArgs[i - 1] === '--model');
    expect(modelFlags.length).toBe(2); // -m and gpt-4
  });

  it('should not add force flag if already present in argv', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    await invokeCursorAgent({ argv: ['-f', 'test'] });

    const callArgs = vi.mocked(spawn).mock.calls[0][1];
    const forceCount = callArgs.filter(arg => arg === '-f' || arg === '--force').length;
    expect(forceCount).toBe(1);
  });

  it('should not add --print when print is false', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    await invokeCursorAgent({ argv: ['test'], print: false });

    const callArgs = vi.mocked(spawn).mock.calls[0][1];
    expect(callArgs).not.toContain('--print');
  });

  it('should return successful output', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'successful output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    const result = await invokeCursorAgent({ argv: ['test'] });

    expect(result.content).toEqual([{ type: 'text', text: 'successful output' }]);
    expect(result.isError).toBeUndefined();
  });

  it('should return error when process exits with non-zero code', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'output', stderr: 'error message', exitCode: 1 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    const result = await invokeCursorAgent({ argv: ['test'] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('exited with code 1');
  });

  it('should handle process errors', async () => {
    const mockProcess = createMockChildProcess({ shouldError: true, errorMessage: 'Process failed to start' });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    const result = await invokeCursorAgent({ argv: ['test'] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to start');
  });

  it('should handle timeout', async () => {
    vi.useFakeTimers();
    process.env.CURSOR_AGENT_TIMEOUT_MS = '100';
    const mockProcess = createMockChildProcess({ stdout: '', exitCode: 0, delay: 200 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    const resultPromise = invokeCursorAgent({ argv: ['test'] });
    vi.advanceTimersByTime(150);

    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('timed out');
  });

  it('should handle idle kill when configured', async () => {
    vi.useFakeTimers();
    process.env.CURSOR_AGENT_IDLE_EXIT_MS = '100';
    const mockProcess = createMockChildProcess({ stdout: 'partial', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    const resultPromise = invokeCursorAgent({ argv: ['test'] });
    // Simulate data arriving, then idle timeout
    setTimeout(() => {
      mockProcess.stdout.emit('data', Buffer.from('data'));
    }, 50);
    vi.advanceTimersByTime(200);

    const result = await resultPromise;
    // Should complete with output even if killed by idle
    expect(result.content).toBeDefined();
  });

  it('should validate working directory', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    await invokeCursorAgent({ argv: ['test'], cwd: './test' });

    const callOptions = vi.mocked(spawn).mock.calls[0][2];
    expect(callOptions.cwd).toBeDefined();
  });

  it('should use safe environment variables', async () => {
    process.env.SECRET_KEY = 'should-not-appear';
    process.env.CURSOR_AGENT_MODEL = 'gpt-4';
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    await invokeCursorAgent({ argv: ['test'] });

    const callOptions = vi.mocked(spawn).mock.calls[0][2];
    expect(callOptions.env.SECRET_KEY).toBeUndefined();
    expect(callOptions.env.CURSOR_AGENT_MODEL).toBe('gpt-4');
  });
});

describe('runCursorAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CURSOR_AGENT_ECHO_PROMPT;
    delete process.env.DEBUG_CURSOR_MCP;
  });

  it('should call invokeCursorAgent with correct arguments', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    await runCursorAgent({ prompt: 'test prompt', output_format: 'text' });

    expect(spawn).toHaveBeenCalledWith(
      'cursor-agent',
      expect.arrayContaining(['test prompt']),
      expect.any(Object),
    );
  });

  it('should handle extra_args', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    await runCursorAgent({ prompt: 'test', extra_args: ['--flag', 'value'] });

    const callArgs = vi.mocked(spawn).mock.calls[0][1];
    expect(callArgs).toContain('--flag');
    expect(callArgs).toContain('value');
    expect(callArgs).toContain('test');
  });

  it('should echo prompt when echo_prompt is true', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    const result = await runCursorAgent({ prompt: 'test prompt', echo_prompt: true });

    expect(result.content[0].text).toContain('Prompt used:');
    expect(result.content[0].text).toContain('test prompt');
  });

  it('should echo prompt when CURSOR_AGENT_ECHO_PROMPT is set', async () => {
    process.env.CURSOR_AGENT_ECHO_PROMPT = '1';
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    const result = await runCursorAgent({ prompt: 'test prompt' });

    expect(result.content[0].text).toContain('Prompt used:');
  });

  it('should handle nested arguments object', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    await runCursorAgent({ arguments: { prompt: 'test prompt' } });

    expect(spawn).toHaveBeenCalledWith(
      'cursor-agent',
      expect.arrayContaining(['test prompt']),
      expect.any(Object),
    );
  });

  it('should handle different output formats', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    await runCursorAgent({ prompt: 'test', output_format: 'markdown' });

    const callArgs = vi.mocked(spawn).mock.calls[0][1];
    expect(callArgs).toContain('--output-format');
    expect(callArgs).toContain('markdown');
  });
});

// Test tool handler logic through runCursorAgent calls
// Since tools call runCursorAgent/invokeCursorAgent, we test the composition logic

describe('Tool handler composition logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.EXECUTING_CLIENT;
  });

  it('should compose edit_file prompt correctly', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    // Simulate cursor_agent_edit_file tool handler logic
    const file = './test/file.txt';
    const instruction = 'Add a comment';
    const validatedFile = path.resolve(file);
    const composedPrompt = `Edit the repository file:\n- File: ${validatedFile}\n- Instruction: ${instruction}\n- Propose a patch/diff without applying.\n`;

    await runCursorAgent({ prompt: composedPrompt });

    const callArgs = vi.mocked(spawn).mock.calls[0][1];
    // Find the prompt argument (it's the last non-flag argument before model/force flags)
    const promptArg = callArgs.find((arg, i) => {
      const prev = callArgs[i - 1];
      return arg && arg !== '-m' && arg !== '--model' && arg !== '-f' && arg !== '--force' &&
             prev !== '-m' && prev !== '--model' && !arg.startsWith('--output-format') &&
             !arg.startsWith('--print') && i > 2; // Skip initial flags
    });
    expect(promptArg).toContain('Edit the repository file');
    expect(promptArg).toContain(instruction);
  });

  it('should compose analyze_files prompt with array of paths', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    // Simulate cursor_agent_analyze_files tool handler logic
    const paths = ['./test/file1.txt', './test/file2.txt'];
    const validatedPaths = paths.map(p => path.resolve(p));
    const composedPrompt = `Analyze the following paths in the repository:\n${validatedPaths.map(p => `- ${p}`).join('\n')}\n`;

    await runCursorAgent({ prompt: composedPrompt });

    const callArgs = vi.mocked(spawn).mock.calls[0][1];
    // Find the prompt argument
    const promptArg = callArgs.find((arg, i) => {
      const prev = callArgs[i - 1];
      return arg && arg !== '-m' && arg !== '--model' && arg !== '-f' && arg !== '--force' &&
             prev !== '-m' && prev !== '--model' && !arg.startsWith('--output-format') &&
             !arg.startsWith('--print') && i > 2;
    });
    expect(promptArg).toContain('Analyze the following paths');
    expect(promptArg).toContain('file1.txt');
    expect(promptArg).toContain('file2.txt');
  });

  it('should compose search_repo prompt with include/exclude globs', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    // Simulate cursor_agent_search_repo tool handler logic
    const query = 'function test';
    const include = ['src/**/*.ts'];
    const exclude = ['node_modules/**'];
    const composedPrompt = `Search the repository for occurrences relevant to:\n- Query: ${query}\n- Include globs:\n  - ${include[0]}\n- Exclude globs:\n  - ${exclude[0]}\nReturn concise findings with file paths and line references.`;

    await runCursorAgent({ prompt: composedPrompt });

    const callArgs = vi.mocked(spawn).mock.calls[0][1];
    // Find the prompt argument
    const promptArg = callArgs.find((arg, i) => {
      const prev = callArgs[i - 1];
      return arg && arg !== '-m' && arg !== '--model' && arg !== '-f' && arg !== '--force' &&
             prev !== '-m' && prev !== '--model' && !arg.startsWith('--output-format') &&
             !arg.startsWith('--print') && i > 2;
    });
    expect(promptArg).toContain('Search the repository');
    expect(promptArg).toContain(query);
    expect(promptArg).toContain('Include globs');
    expect(promptArg).toContain('Exclude globs');
  });

  it('should compose plan_task prompt with constraints', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    // Simulate cursor_agent_plan_task tool handler logic
    const goal = 'Set up CI';
    const constraints = ['GitHub Actions', 'Node 18'];
    const composedPrompt = `Create a step-by-step plan to accomplish the following goal:\n- Goal: ${goal}\n- Constraints:\n  - ${constraints[0]}\n  - ${constraints[1]}\nProvide a numbered list of actions.`;

    await runCursorAgent({ prompt: composedPrompt });

    const callArgs = vi.mocked(spawn).mock.calls[0][1];
    // Find the prompt argument
    const promptArg = callArgs.find((arg, i) => {
      const prev = callArgs[i - 1];
      return arg && arg !== '-m' && arg !== '--model' && arg !== '-f' && arg !== '--force' &&
             prev !== '-m' && prev !== '--model' && !arg.startsWith('--output-format') &&
             !arg.startsWith('--print') && i > 2;
    });
    expect(promptArg).toContain('Create a step-by-step plan');
    expect(promptArg).toContain(goal);
    expect(promptArg).toContain('Constraints');
  });

  it('should handle raw tool with print=false', async () => {
    const mockProcess = createMockChildProcess({ stdout: 'help output', exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    // Simulate cursor_agent_raw tool handler logic
    await invokeCursorAgent({ argv: ['--help'], print: false });

    const callArgs = vi.mocked(spawn).mock.calls[0][1];
    expect(callArgs).not.toContain('--print');
    expect(callArgs).toContain('--help');
  });
});

