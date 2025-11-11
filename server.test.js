import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import {
  validateExecutablePath,
  validateWorkingDirectory,
  validateFilePath,
  getSafeEnvironment,
} from './server.js';

describe('validateExecutablePath', () => {
  const originalEnv = process.env.CURSOR_AGENT_PATH;

  beforeEach(() => {
    delete process.env.CURSOR_AGENT_PATH;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.CURSOR_AGENT_PATH = originalEnv;
    } else {
      delete process.env.CURSOR_AGENT_PATH;
    }
  });

  it('should return "cursor-agent" when no explicit path is provided', () => {
    const result = validateExecutablePath();
    expect(result).toBe('cursor-agent');
  });

  it('should return "cursor-agent" when empty string is provided', () => {
    const result = validateExecutablePath('');
    expect(result).toBe('cursor-agent');
  });

  it('should return "cursor-agent" when whitespace-only string is provided', () => {
    const result = validateExecutablePath('   ');
    expect(result).toBe('cursor-agent');
  });

  it('should allow "cursor-agent" as explicit path', () => {
    const result = validateExecutablePath('cursor-agent');
    expect(result).toBe('cursor-agent');
  });

  it('should allow "cursor-agent" with whitespace', () => {
    const result = validateExecutablePath('  cursor-agent  ');
    expect(result).toBe('cursor-agent');
  });

  it('should use CURSOR_AGENT_PATH when set and no explicit path', () => {
    process.env.CURSOR_AGENT_PATH = '/usr/local/bin/cursor-agent';
    const result = validateExecutablePath();
    expect(result).toBe('/usr/local/bin/cursor-agent');
  });

  it('should use CURSOR_AGENT_PATH when explicitly matched', () => {
    process.env.CURSOR_AGENT_PATH = '/usr/local/bin/cursor-agent';
    const result = validateExecutablePath('/usr/local/bin/cursor-agent');
    expect(result).toBe('/usr/local/bin/cursor-agent');
  });

  it('should reject invalid executable paths', () => {
    expect(() => validateExecutablePath('/usr/bin/evil')).toThrow(
      'Invalid executable path: "/usr/bin/evil". Only "cursor-agent" or exact match to CURSOR_AGENT_PATH is allowed.',
    );
  });

  it('should reject relative paths', () => {
    expect(() => validateExecutablePath('./cursor-agent')).toThrow();
  });

  it('should reject CURSOR_AGENT_PATH with path traversal', () => {
    process.env.CURSOR_AGENT_PATH = '../../malicious/path';
    expect(() => validateExecutablePath()).toThrow(
      'CURSOR_AGENT_PATH contains invalid path traversal',
    );
  });

  it('should reject CURSOR_AGENT_PATH with relative path containing slash', () => {
    process.env.CURSOR_AGENT_PATH = 'bin/cursor-agent';
    expect(() => validateExecutablePath()).toThrow(
      'CURSOR_AGENT_PATH contains invalid path traversal',
    );
  });

  it('should accept absolute CURSOR_AGENT_PATH', () => {
    const absPath = path.resolve('/tmp/cursor-agent');
    process.env.CURSOR_AGENT_PATH = absPath;
    const result = validateExecutablePath();
    expect(result).toBe(absPath);
  });

  it('should normalize CURSOR_AGENT_PATH', () => {
    process.env.CURSOR_AGENT_PATH = '/usr/local/../bin/cursor-agent';
    const result = validateExecutablePath();
    expect(result).toContain('cursor-agent');
  });
});

describe('validateWorkingDirectory', () => {
  const originalCwd = process.cwd();

  it('should return process.cwd() when no cwd is provided', () => {
    const result = validateWorkingDirectory();
    expect(result).toBe(process.cwd());
  });

  it('should return process.cwd() when empty string is provided', () => {
    const result = validateWorkingDirectory('');
    expect(result).toBe(process.cwd());
  });

  it('should return process.cwd() when whitespace-only string is provided', () => {
    const result = validateWorkingDirectory('   ');
    expect(result).toBe(process.cwd());
  });

  it('should accept valid subdirectory paths', () => {
    const subdir = path.join(process.cwd(), 'test');
    const result = validateWorkingDirectory(subdir);
    expect(result).toBe(path.resolve(subdir));
  });

  it('should accept current directory', () => {
    const result = validateWorkingDirectory('.');
    expect(result).toBe(process.cwd());
  });

  it('should reject paths outside base directory', () => {
    const outsidePath = '/tmp';
    expect(() => validateWorkingDirectory(outsidePath)).toThrow(
      `Working directory "${outsidePath}" is outside allowed path "${process.cwd()}"`,
    );
  });

  it('should reject path traversal attempts that escape base directory', () => {
    const traversalPath = path.join(process.cwd(), '..', '..', 'tmp');
    expect(() => validateWorkingDirectory(traversalPath)).toThrow();
  });

  it('should accept path traversal that stays within base directory', () => {
    const safeTraversal = path.join(process.cwd(), 'test', '..', 'test');
    const result = validateWorkingDirectory(safeTraversal);
    expect(result).toBe(path.resolve(process.cwd(), 'test'));
  });

  it('should normalize and resolve paths', () => {
    const subdir = path.join(process.cwd(), 'test', 'subdir');
    const result = validateWorkingDirectory(subdir);
    expect(result).toBe(path.resolve(subdir));
  });

  it('should handle paths with whitespace', () => {
    const subdir = path.join(process.cwd(), 'test');
    const result = validateWorkingDirectory(`  ${subdir}  `);
    expect(result).toBe(path.resolve(subdir));
  });

  it('should reject paths that share a prefix but are outside base directory', () => {
    // Create a path that shares a prefix but is actually outside
    // e.g., if baseDir is "/home/user/repo", "/home/user/repo-evil" should be rejected
    const baseDir = process.cwd();
    const baseDirName = path.basename(baseDir);
    const parentDir = path.dirname(baseDir);
    const prefixAttackPath = path.join(parentDir, `${baseDirName}-evil`);

    expect(() => validateWorkingDirectory(prefixAttackPath)).toThrow(
      `Working directory "${prefixAttackPath}" is outside allowed path "${baseDir}"`,
    );
  });

  it('should accept the exact base directory', () => {
    const result = validateWorkingDirectory(process.cwd());
    expect(result).toBe(process.cwd());
  });
});

describe('validateFilePath', () => {
  it('should throw error when file path is empty', () => {
    expect(() => validateFilePath('')).toThrow('File path is required');
  });

  it('should throw error when file path is whitespace only', () => {
    expect(() => validateFilePath('   ')).toThrow('File path is required');
  });

  it('should throw error when file path is null', () => {
    expect(() => validateFilePath(null)).toThrow('File path is required');
  });

  it('should throw error when file path is undefined', () => {
    expect(() => validateFilePath(undefined)).toThrow('File path is required');
  });

  it('should accept valid file paths within project', () => {
    const filePath = path.join(process.cwd(), 'test', 'file.txt');
    const result = validateFilePath(filePath);
    expect(result).toBe(path.resolve(filePath));
  });

  it('should accept relative file paths', () => {
    const filePath = './test/file.txt';
    const result = validateFilePath(filePath);
    expect(result).toBe(path.resolve(filePath));
  });

  it('should reject paths outside project directory', () => {
    const outsidePath = '/tmp/file.txt';
    expect(() => validateFilePath(outsidePath)).toThrow(
      `File path "${outsidePath}" is outside allowed directory "${process.cwd()}"`,
    );
  });

  it('should reject path traversal attempts that escape base directory', () => {
    const traversalPath = path.join(process.cwd(), '..', '..', 'tmp', 'file.txt');
    expect(() => validateFilePath(traversalPath)).toThrow();
  });

  it('should accept path traversal that stays within base directory', () => {
    const safeTraversal = path.join(process.cwd(), 'test', '..', 'file.txt');
    const result = validateFilePath(safeTraversal);
    expect(result).toBe(path.resolve(process.cwd(), 'file.txt'));
  });

  it('should normalize and resolve file paths', () => {
    const filePath = path.join(process.cwd(), 'test', 'subdir', 'file.txt');
    const result = validateFilePath(filePath);
    expect(result).toBe(path.resolve(filePath));
  });

  it('should handle paths with whitespace', () => {
    const filePath = path.join(process.cwd(), 'test file.txt');
    const result = validateFilePath(`  ${filePath}  `);
    expect(result).toBe(path.resolve(filePath));
  });

  it('should reject file paths that share a prefix but are outside base directory', () => {
    // Create a path that shares a prefix but is actually outside
    // e.g., if baseDir is "/home/user/repo", "/home/user/repo-evil/file.txt" should be rejected
    const baseDir = process.cwd();
    const baseDirName = path.basename(baseDir);
    const parentDir = path.dirname(baseDir);
    const prefixAttackPath = path.join(parentDir, `${baseDirName}-evil`, 'file.txt');

    expect(() => validateFilePath(prefixAttackPath)).toThrow(
      `File path "${prefixAttackPath}" is outside allowed directory "${baseDir}"`,
    );
  });

  it('should accept file paths in the exact base directory', () => {
    const filePath = path.join(process.cwd(), 'file.txt');
    const result = validateFilePath(filePath);
    expect(result).toBe(path.resolve(filePath));
  });
});

describe('getSafeEnvironment', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear and set up test environment
    for (const key in process.env) {
      if (!['PATH', 'HOME'].includes(key)) {
        delete process.env[key];
      }
    }
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/test';
    process.env.USER = 'testuser';
    process.env.USERNAME = 'testuser';
    process.env.SHELL = '/bin/bash';
    process.env.TMPDIR = '/tmp';
    process.env.NODE_VERSION = '18.0.0';
    process.env.LANG = 'en_US.UTF-8';
    process.env.LANGUAGE = 'en';
    process.env.LC_ALL = 'en_US.UTF-8';
    process.env.LC_COLLATE = 'en_US.UTF-8';
    process.env.EXECUTING_CLIENT = 'cursor';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should include whitelisted system variables', () => {
    const safeEnv = getSafeEnvironment();
    expect(safeEnv.PATH).toBe('/usr/bin');
    expect(safeEnv.HOME).toBe('/home/test');
    expect(safeEnv.USER).toBe('testuser');
    expect(safeEnv.USERNAME).toBe('testuser');
    expect(safeEnv.SHELL).toBe('/bin/bash');
    expect(safeEnv.TMPDIR).toBe('/tmp');
  });

  it('should include NODE_VERSION', () => {
    const safeEnv = getSafeEnvironment();
    expect(safeEnv.NODE_VERSION).toBe('18.0.0');
  });

  it('should include locale variables', () => {
    const safeEnv = getSafeEnvironment();
    expect(safeEnv.LANG).toBe('en_US.UTF-8');
    expect(safeEnv.LANGUAGE).toBe('en');
  });

  it('should include CURSOR_AGENT_* variables', () => {
    process.env.CURSOR_AGENT_MODEL = 'gpt-4';
    process.env.CURSOR_AGENT_PATH = '/usr/bin/cursor-agent';
    process.env.CURSOR_AGENT_FORCE = 'true';
    const safeEnv = getSafeEnvironment();
    expect(safeEnv.CURSOR_AGENT_MODEL).toBe('gpt-4');
    expect(safeEnv.CURSOR_AGENT_PATH).toBe('/usr/bin/cursor-agent');
    expect(safeEnv.CURSOR_AGENT_FORCE).toBe('true');
  });

  it('should include NPM_CONFIG_* variables', () => {
    process.env.NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org';
    process.env.NPM_CONFIG_PROXY = 'http://proxy.example.com';
    const safeEnv = getSafeEnvironment();
    expect(safeEnv.NPM_CONFIG_REGISTRY).toBe('https://registry.npmjs.org');
    expect(safeEnv.NPM_CONFIG_PROXY).toBe('http://proxy.example.com');
  });

  it('should include LC_* variables', () => {
    process.env.LC_ALL = 'en_US.UTF-8';
    process.env.LC_COLLATE = 'en_US.UTF-8';
    process.env.LC_CTYPE = 'en_US.UTF-8';
    const safeEnv = getSafeEnvironment();
    expect(safeEnv.LC_ALL).toBe('en_US.UTF-8');
    expect(safeEnv.LC_COLLATE).toBe('en_US.UTF-8');
    expect(safeEnv.LC_CTYPE).toBe('en_US.UTF-8');
  });

  it('should exclude sensitive variables not in whitelist', () => {
    process.env.SECRET_KEY = 'secret-value';
    process.env.API_TOKEN = 'token-value';
    process.env.PASSWORD = 'password-value';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
    const safeEnv = getSafeEnvironment();
    expect(safeEnv.SECRET_KEY).toBeUndefined();
    expect(safeEnv.API_TOKEN).toBeUndefined();
    expect(safeEnv.PASSWORD).toBeUndefined();
    expect(safeEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('should include EXECUTING_CLIENT', () => {
    const safeEnv = getSafeEnvironment();
    expect(safeEnv.EXECUTING_CLIENT).toBe('cursor');
  });

  it('should handle empty environment', () => {
    const originalEnvKeys = Object.keys(process.env);
    for (const key of originalEnvKeys) {
      delete process.env[key];
    }
    const safeEnv = getSafeEnvironment();
    expect(Object.keys(safeEnv).length).toBe(0);
  });

  it('should handle TEMP and TMP variables', () => {
    process.env.TEMP = '/tmp';
    process.env.TMP = '/tmp';
    const safeEnv = getSafeEnvironment();
    expect(safeEnv.TEMP).toBe('/tmp');
    expect(safeEnv.TMP).toBe('/tmp');
  });
});

