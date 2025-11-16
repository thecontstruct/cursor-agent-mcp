import { EventEmitter } from 'node:events';

/**
 * Creates a mock child process that can be controlled in tests
 */
export function createMockChildProcess(options = {}) {
  const {
    stdout = '',
    stderr = '',
    exitCode = 0,
    shouldError = false,
    errorMessage = 'Process error',
    delay = 0,
  } = options;

  const mockProcess = new EventEmitter();
  mockProcess.stdout = new EventEmitter();
  mockProcess.stderr = new EventEmitter();
  mockProcess.stdin = {
    end: () => {},
  };
  mockProcess.kill = () => {};

  // Simulate async behavior
  setTimeout(() => {
    if (shouldError) {
      mockProcess.emit('error', new Error(errorMessage));
    } else {
      // Emit stdout data
      if (stdout) {
        mockProcess.stdout.emit('data', Buffer.from(stdout));
      }
      // Emit stderr data
      if (stderr) {
        mockProcess.stderr.emit('data', Buffer.from(stderr));
      }
      // Emit close event
      mockProcess.emit('close', exitCode);
    }
  }, delay);

  return mockProcess;
}

/**
 * Creates a mock spawn function for use in tests
 */
export function createMockSpawn(mockProcesses = []) {
  let callIndex = 0;
  const calls = [];

  const mockSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    const mockProcess = Array.isArray(mockProcesses)
      ? mockProcesses[callIndex % mockProcesses.length]
      : mockProcesses;
    callIndex++;
    return typeof mockProcess === 'function'
      ? mockProcess({ command, args, options })
      : mockProcess || createMockChildProcess();
  };

  mockSpawn.calls = calls;
  mockSpawn.reset = () => {
    callIndex = 0;
    calls.length = 0;
  };

  return mockSpawn;
}

/**
 * Test fixtures
 */
export const fixtures = {
  samplePrompt: 'Test prompt for cursor-agent',
  sampleFilePath: './test/fixtures/sample.txt',
  samplePaths: ['./test/fixtures/file1.txt', './test/fixtures/file2.txt'],
  sampleQuery: 'function test',
  sampleGoal: 'Set up testing infrastructure',
  sampleConstraints: ['Use Vitest', 'Node 18+'],
};






