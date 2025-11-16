// MCP wrapper server for cursor-agent CLI
// Exposes multiple tools (chat/edit/analyze/search/plan/raw + legacy run) for better discoverability.
// Start via MCP config (stdio). Requires Node 18+.

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';

// Environment variable schemas and validation
// Helper to parse boolean-like env vars ('1', 'true', 'yes', 'on')
const booleanEnvSchema = z
  .string()
  .optional()
  .transform((val) => {
    if (!val) return false;
    const lower = val.toLowerCase().trim();
    return lower === '1' || lower === 'true' || lower === 'yes' || lower === 'on';
  });

// Helper to parse positive integer milliseconds
const positiveIntMsSchema = z
  .string()
  .optional()
  .transform((val) => {
    if (!val) return undefined;
    const parsed = Number.parseInt(val.trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 0) return undefined;
    return parsed;
  });

// Helper to validate executable path (security: no path traversal)
const executablePathSchema = z
  .string()
  .optional()
  .transform((val) => {
    if (!val || !val.trim()) return undefined;
    const trimmed = val.trim();
    const normalized = path.normalize(trimmed);
    if (normalized.includes('..') || (!path.isAbsolute(normalized) && normalized.includes('/'))) {
      throw new Error('CURSOR_AGENT_PATH contains invalid path traversal');
    }
    return path.isAbsolute(normalized) ? normalized : trimmed;
  });

// Complete environment variable schema
const ENV_SCHEMA = z.object({
  EXECUTING_CLIENT: z.enum(['cursor', 'clause']).optional(),
  CURSOR_AGENT_PATH: executablePathSchema,
  DEBUG_CURSOR_MCP: booleanEnvSchema,
  CURSOR_AGENT_ECHO_PROMPT: booleanEnvSchema,
  CURSOR_AGENT_MODEL: z.string().trim().min(1).optional(),
  CURSOR_AGENT_FORCE: booleanEnvSchema,
  CURSOR_AGENT_IDLE_EXIT_MS: positiveIntMsSchema,
  CURSOR_AGENT_TIMEOUT_MS: positiveIntMsSchema,
});

// Validate and parse all environment variables (lazy validation with caching)
let validatedEnvCache = null;
let validatedEnvCacheKey = null;
let isStartup = true;

function getValidatedEnv() {
  // Create a cache key from current env values
  const cacheKey = JSON.stringify({
    EXECUTING_CLIENT: process.env.EXECUTING_CLIENT,
    CURSOR_AGENT_PATH: process.env.CURSOR_AGENT_PATH,
    DEBUG_CURSOR_MCP: process.env.DEBUG_CURSOR_MCP,
    CURSOR_AGENT_ECHO_PROMPT: process.env.CURSOR_AGENT_ECHO_PROMPT,
    CURSOR_AGENT_MODEL: process.env.CURSOR_AGENT_MODEL,
    CURSOR_AGENT_FORCE: process.env.CURSOR_AGENT_FORCE,
    CURSOR_AGENT_IDLE_EXIT_MS: process.env.CURSOR_AGENT_IDLE_EXIT_MS,
    CURSOR_AGENT_TIMEOUT_MS: process.env.CURSOR_AGENT_TIMEOUT_MS,
  });

  // Return cached result if env vars haven't changed
  if (validatedEnvCache && validatedEnvCacheKey === cacheKey) {
    return validatedEnvCache;
  }

  // Validate and cache
  try {
    validatedEnvCache = ENV_SCHEMA.parse({
      EXECUTING_CLIENT: process.env.EXECUTING_CLIENT,
      CURSOR_AGENT_PATH: process.env.CURSOR_AGENT_PATH,
      DEBUG_CURSOR_MCP: process.env.DEBUG_CURSOR_MCP,
      CURSOR_AGENT_ECHO_PROMPT: process.env.CURSOR_AGENT_ECHO_PROMPT,
      CURSOR_AGENT_MODEL: process.env.CURSOR_AGENT_MODEL,
      CURSOR_AGENT_FORCE: process.env.CURSOR_AGENT_FORCE,
      CURSOR_AGENT_IDLE_EXIT_MS: process.env.CURSOR_AGENT_IDLE_EXIT_MS,
      CURSOR_AGENT_TIMEOUT_MS: process.env.CURSOR_AGENT_TIMEOUT_MS,
    });
    validatedEnvCacheKey = cacheKey;
    return validatedEnvCache;
  } catch (error) {
    // At startup, exit on invalid config. Otherwise, throw for tests/functions.
    if (isStartup) {
      console.error('Invalid environment variable configuration:', error.message);
      if (error.errors) {
        for (const err of error.errors) {
          console.error(`  - ${err.path.join('.')}: ${err.message}`);
        }
      }
      process.exit(1);
    }
    // Re-throw the error for non-startup contexts (e.g., tests)
    throw error;
  }
}

// Validate at startup (will exit if invalid)
isStartup = true;
getValidatedEnv();
isStartup = false;

// Security validation utilities

/**
 * Validates executable path to prevent arbitrary command execution.
 * Only allows "cursor-agent" (for PATH lookup) or exact match to CURSOR_AGENT_PATH env var.
 */
function validateExecutablePath(explicit) {
  const env = getValidatedEnv();
  if (!explicit || !explicit.trim()) {
    // No explicit path provided, check validated env var or default
    const envPath = env.CURSOR_AGENT_PATH;
    if (envPath) {
      return envPath;
    }
    return 'cursor-agent';
  }

  const trimmed = explicit.trim();

  // Allow "cursor-agent" for PATH lookup
  if (trimmed === 'cursor-agent') {
    return 'cursor-agent';
  }

  // Check if it matches CURSOR_AGENT_PATH exactly
  const envPath = env.CURSOR_AGENT_PATH;
  if (envPath && trimmed === envPath) {
    return envPath;
  }

  // Reject all other paths (prevents arbitrary executable execution)
  throw new Error(`Invalid executable path: "${trimmed}". Only "cursor-agent" or exact match to CURSOR_AGENT_PATH is allowed.`);
}

/**
 * Validates working directory to prevent path traversal attacks.
 * Ensures cwd is within process.cwd() or its subdirectories.
 */
function validateWorkingDirectory(cwd) {
  if (!cwd || !cwd.trim()) {
    return process.cwd();
  }

  const trimmed = cwd.trim();
  const resolved = path.resolve(trimmed);
  const baseDir = process.cwd();
  const baseDirResolved = path.resolve(baseDir);

  // Ensure resolved path is exactly the base directory or a subdirectory
  // Use path.sep to prevent prefix attacks (e.g., "/home/user/repo-evil" should not pass)
  if (resolved !== baseDirResolved && !resolved.startsWith(baseDirResolved + path.sep)) {
    throw new Error(`Working directory "${trimmed}" is outside allowed path "${baseDir}"`);
  }

  // Check for path traversal attempts
  const normalized = path.normalize(trimmed);
  if (normalized.includes('..')) {
    const normalizedResolved = path.resolve(normalized);
    if (normalizedResolved !== baseDirResolved && !normalizedResolved.startsWith(baseDirResolved + path.sep)) {
      throw new Error(`Working directory "${trimmed}" contains invalid path traversal`);
    }
  }

  return resolved;
}

/**
 * Validates file paths to prevent path traversal attacks.
 * Ensures paths are within process.cwd() or its subdirectories.
 */
function validateFilePath(filePath) {
  if (!filePath || !filePath.trim()) {
    throw new Error('File path is required');
  }

  const trimmed = filePath.trim();
  const resolved = path.resolve(trimmed);
  const baseDir = process.cwd();
  const baseDirResolved = path.resolve(baseDir);

  // Ensure resolved path is exactly the base directory or a subdirectory
  // Use path.sep to prevent prefix attacks (e.g., "/home/user/repo-evil" should not pass)
  if (resolved !== baseDirResolved && !resolved.startsWith(baseDirResolved + path.sep)) {
    throw new Error(`File path "${trimmed}" is outside allowed directory "${baseDir}"`);
  }

  // Check for path traversal attempts
  const normalized = path.normalize(trimmed);
  if (normalized.includes('..')) {
    const normalizedResolved = path.resolve(normalized);
    if (normalizedResolved !== baseDirResolved && !normalizedResolved.startsWith(baseDirResolved + path.sep)) {
      throw new Error(`File path "${trimmed}" contains invalid path traversal`);
    }
  }

  return resolved;
}

/**
 * Creates a safe environment object with only whitelisted variables.
 * Prevents leakage of sensitive credentials and secrets.
 * Uses validated environment variables where applicable.
 */
function getSafeEnvironment() {
  const whitelist = new Set([
    // System variables
    'PATH',
    'HOME',
    'USER',
    'USERNAME',
    'SHELL',
    'TMPDIR',
    'TEMP',
    'TMP',
    // Node.js variables
    'NODE_VERSION',
    // Locale variables
    'LANG',
    'LANGUAGE',
    // MCP client identifier
    'EXECUTING_CLIENT',
  ]);

  // Add all CURSOR_AGENT_* variables
  const cursorAgentPrefix = 'CURSOR_AGENT_';
  // Add all NPM_CONFIG_* variables
  const npmConfigPrefix = 'NPM_CONFIG_';
  // Add all LC_* variables (locale categories)
  const lcPrefix = 'LC_';

  const safeEnv = {};

  // Add validated environment variables (convert back to strings for env)
  const env = getValidatedEnv();
  if (env.EXECUTING_CLIENT) {
    safeEnv.EXECUTING_CLIENT = env.EXECUTING_CLIENT;
  }
  if (env.CURSOR_AGENT_PATH) {
    safeEnv.CURSOR_AGENT_PATH = env.CURSOR_AGENT_PATH;
  }
  // Preserve original string values for boolean env vars if they were valid
  if (env.DEBUG_CURSOR_MCP) {
    safeEnv.DEBUG_CURSOR_MCP = process.env.DEBUG_CURSOR_MCP || '1';
  }
  if (env.CURSOR_AGENT_ECHO_PROMPT) {
    safeEnv.CURSOR_AGENT_ECHO_PROMPT = process.env.CURSOR_AGENT_ECHO_PROMPT || '1';
  }
  if (env.CURSOR_AGENT_MODEL) {
    safeEnv.CURSOR_AGENT_MODEL = env.CURSOR_AGENT_MODEL;
  }
  if (env.CURSOR_AGENT_FORCE) {
    safeEnv.CURSOR_AGENT_FORCE = process.env.CURSOR_AGENT_FORCE || '1';
  }
  if (env.CURSOR_AGENT_IDLE_EXIT_MS !== undefined) {
    safeEnv.CURSOR_AGENT_IDLE_EXIT_MS = String(env.CURSOR_AGENT_IDLE_EXIT_MS);
  }
  if (env.CURSOR_AGENT_TIMEOUT_MS !== undefined) {
    safeEnv.CURSOR_AGENT_TIMEOUT_MS = String(env.CURSOR_AGENT_TIMEOUT_MS);
  }

  // Add other whitelisted variables from process.env
  for (const [key, value] of Object.entries(process.env)) {
    if (
      whitelist.has(key) ||
      key.startsWith(cursorAgentPrefix) ||
      key.startsWith(npmConfigPrefix) ||
      key.startsWith(lcPrefix)
    ) {
      // Only add if not already set from validated env
      if (!(key in safeEnv)) {
        safeEnv[key] = value;
      }
    }
  }

  return safeEnv;
}

// Export validation functions and core functions for testing
export {
  validateExecutablePath,
  validateWorkingDirectory,
  validateFilePath,
  getSafeEnvironment,
  invokeCursorAgent,
  runCursorAgent,
};

// Tool input schema
const RUN_SCHEMA = z.object({
  prompt: z.string().min(1, 'prompt is required'),
  output_format: z.enum(['text', 'json', 'markdown']).default('text'),
  extra_args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  // Optional override for the executable path if not on PATH
  executable: z.string().optional(),
  // Optional model and force for parity with other tools/env overrides
  model: z.string().optional(),
  force: z.boolean().optional(),
});

// Resolve the executable path for cursor-agent
function resolveExecutable(explicit) {
  return validateExecutablePath(explicit);
}

/**
* Internal executor that spawns cursor-agent with provided argv and common options.
* Adds --print and --output-format, handles env/model/force, timeouts and idle kill.
* Supports progress notifications when onProgress callback is provided.
*/
async function invokeCursorAgent({ argv, output_format = 'text', cwd, executable, model, force, print = true, onProgress }) {
 const cmd = resolveExecutable(executable);
 const validatedCwd = validateWorkingDirectory(cwd);
 const safeEnv = getSafeEnvironment();

 // Compute model/force from args/env
 const env = getValidatedEnv();
 const userArgs = [...(argv ?? [])];
 const hasModelFlag = userArgs.some((a) => a === '-m' || a === '--model' || /^(?:-m=|--model=)/.test(String(a)));
 const envModel = env.CURSOR_AGENT_MODEL;
 const effectiveModel = model?.trim?.() || envModel;

 const hasForceFlag = userArgs.some((a) => a === '-f' || a === '--force');
 const envForce = env.CURSOR_AGENT_FORCE;
 const effectiveForce = typeof force === 'boolean' ? force : envForce;

 // Extract prompt (last non-flag argument) to ensure it's the final argument
 let promptArg = null;
 let argsWithoutPrompt = userArgs;
 if (userArgs.length > 0) {
   const lastArg = userArgs[userArgs.length - 1];
   // If last argument doesn't start with '-', treat it as the prompt
   if (lastArg && typeof lastArg === 'string' && !lastArg.startsWith('-')) {
     promptArg = lastArg;
     argsWithoutPrompt = userArgs.slice(0, -1);
   }
 }

 // If progress is requested, use stream-json format for parsing
 const useStreamJson = !!onProgress;
 const finalOutputFormat = useStreamJson ? 'stream-json' : output_format;

 const finalArgv = [
   ...(print ? ['--print', '--output-format', finalOutputFormat] : []),
   ...(useStreamJson && print ? ['--stream-partial-output'] : []), // Enable incremental deltas
   ...argsWithoutPrompt,
   ...(hasForceFlag || !effectiveForce ? [] : ['-f']),
   ...(hasModelFlag || !effectiveModel ? [] : ['--model', effectiveModel]),
   ...(promptArg ? [promptArg] : []),
 ];

 return new Promise((resolve) => {
   let settled = false;
   let out = '';
   let err = '';
   let idleTimer = null;
   let killedByIdle = false;

   // State for stream-json parsing
   let accumulatedText = '';
   let toolCount = 0;
   let partialLine = ''; // Buffer for incomplete JSON lines

   const cleanup = () => {
     if (mainTimer) clearTimeout(mainTimer);
     if (idleTimer) clearTimeout(idleTimer);
   };

   const debugEnv2 = getValidatedEnv();
   if (debugEnv2.DEBUG_CURSOR_MCP) {
     try {
       console.error('[cursor-mcp] spawn:', cmd, ...finalArgv);
     } catch {}
   }

   const child = spawn(cmd, finalArgv, {
     shell: false, // safer across platforms; rely on PATH/PATHEXT
     cwd: validatedCwd,
     env: safeEnv,
   });
   try { child.stdin?.end(); } catch {}

   const idleEnv = getValidatedEnv();
   const idleMs = idleEnv.CURSOR_AGENT_IDLE_EXIT_MS ?? 0;
   const scheduleIdleKill = () => {
     if (!idleMs || idleMs <= 0) return;
     if (idleTimer) clearTimeout(idleTimer);
     idleTimer = setTimeout(() => {
       killedByIdle = true;
       try { child.kill('SIGKILL'); } catch {}
     }, idleMs);
   };

   // Helper to handle stream-json events
   const handleStreamEvent = (event) => {
     if (!onProgress || !event || typeof event !== 'object') return;

     const { type, subtype } = event;

     try {
       switch (type) {
         case 'system':
           if (subtype === 'init') {
             const modelName = event.model || 'unknown';
             onProgress({
               progress: 0,
               message: `Initializing cursor-agent (model: ${modelName})...`
             });
           }
           break;

         case 'assistant':
           // Accumulate text deltas from streaming output
           const text = event.message?.content?.[0]?.text || '';
           if (text) {
             accumulatedText += text;
             onProgress({
               progress: accumulatedText.length,
               message: `Generating response... (${accumulatedText.length} characters)`
             });
           }
           break;

         case 'tool_call':
           if (subtype === 'started') {
             toolCount++;
             const toolCall = event.tool_call;

             if (toolCall?.writeToolCall) {
               const path = toolCall.writeToolCall?.args?.path || 'unknown';
               onProgress({
                 progress: toolCount,
                 message: `Writing file: ${path}`
               });
             } else if (toolCall?.readToolCall) {
               const path = toolCall.readToolCall?.args?.path || 'unknown';
               onProgress({
                 progress: toolCount,
                 message: `Reading file: ${path}`
               });
             } else {
               // Generic tool call
               onProgress({
                 progress: toolCount,
                 message: `Executing tool #${toolCount}...`
               });
             }
           } else if (subtype === 'completed') {
             const toolCall = event.tool_call;

             if (toolCall?.writeToolCall?.result?.success) {
               const { linesCreated, fileSize } = toolCall.writeToolCall.result.success;
               onProgress({
                 progress: toolCount,
                 message: `✅ Created ${linesCreated || 0} lines (${fileSize || 0} bytes)`
               });
             } else if (toolCall?.readToolCall?.result?.success) {
               const { totalLines } = toolCall.readToolCall.result.success;
               onProgress({
                 progress: toolCount,
                 message: `✅ Read ${totalLines || 0} lines`
               });
             } else if (toolCall?.writeToolCall?.result || toolCall?.readToolCall?.result) {
               // Tool completed but might have error - still report completion
               onProgress({
                 progress: toolCount,
                 message: `✅ Tool #${toolCount} completed`
               });
             }
           }
           break;

         case 'result':
           const duration = event.duration_ms || 0;
           onProgress({
             progress: 100,
             total: 100,
             message: `Completed in ${duration}ms`
           });
           break;
       }
     } catch (e) {
       // Silently ignore errors in progress handling to avoid breaking the main flow
       if (debugEnv2.DEBUG_CURSOR_MCP) {
         try {
           console.error('[cursor-mcp] progress error:', e);
         } catch {}
       }
     }
   };

   child.stdout.on('data', (d) => {
     const chunk = d.toString();
     out += chunk;
     scheduleIdleKill();

     if (useStreamJson && onProgress) {
       // Parse JSON lines from stream-json output
       const data = partialLine + chunk;
       const lines = data.split('\n');

       // Keep the last line as it might be incomplete
       partialLine = lines.pop() || '';

       // Process complete lines
       for (const line of lines) {
         const trimmed = line.trim();
         if (!trimmed) continue;

         try {
           const event = JSON.parse(trimmed);
           handleStreamEvent(event);
         } catch (e) {
           // Not valid JSON - might be partial or malformed, skip it
           if (debugEnv2.DEBUG_CURSOR_MCP) {
             try {
               console.error('[cursor-mcp] failed to parse JSON line:', trimmed.slice(0, 100));
             } catch {}
           }
         }
       }
     } else if (onProgress) {
       // Simple progress for non-streaming formats
       onProgress({
         progress: out.length,
         message: `Received ${out.length} bytes of output...`
       });
     }
   });

   child.stderr.on('data', (d) => {
     err += d.toString();
     // Don't send progress notifications for stderr - just collect it
     // It will be included in the final result if there's an error
   });

   child.on('error', (e) => {
     if (settled) return;
     settled = true;
     cleanup();
     const errorEnv = getValidatedEnv();
     if (errorEnv.DEBUG_CURSOR_MCP) {
       try { console.error('[cursor-mcp] error:', e); } catch {}
     }
     const msg =
       `Failed to start "${cmd}": ${e?.message || e}\n` +
       `Args: ${JSON.stringify(finalArgv)}\n` +
       (safeEnv.CURSOR_AGENT_PATH ? `CURSOR_AGENT_PATH=${safeEnv.CURSOR_AGENT_PATH}\n` : '');
     resolve({ content: [{ type: 'text', text: msg }], isError: true });
   });

   const defaultTimeout = 30000;
   const timeoutEnv2 = getValidatedEnv();
   const timeoutMs = timeoutEnv2.CURSOR_AGENT_TIMEOUT_MS ?? defaultTimeout;
   const mainTimer = setTimeout(() => {
     try { child.kill('SIGKILL'); } catch {}
     if (settled) return;
     settled = true;
     cleanup();
     resolve({
       content: [{ type: 'text', text: `cursor-agent timed out after ${timeoutMs}ms` }],
       isError: true,
     });
   }, timeoutMs);

   child.on('close', (code) => {
     if (settled) return;
     settled = true;
     cleanup();

     // Process any remaining partial line
     if (useStreamJson && onProgress && partialLine.trim()) {
       try {
         const event = JSON.parse(partialLine.trim());
         handleStreamEvent(event);
       } catch {}
     }

     const closeEnv = getValidatedEnv();
     if (closeEnv.DEBUG_CURSOR_MCP) {
       try { console.error('[cursor-mcp] exit:', code, 'stdout bytes=', out.length, 'stderr bytes=', err.length); } catch {}
     }
     if (code === 0 || (killedByIdle && out)) {
       resolve({ content: [{ type: 'text', text: out || '(no output)' }] });
     } else {
       resolve({
         content: [{ type: 'text', text: `cursor-agent exited with code ${code}\n${err || out || '(no output)'}` }],
         isError: true,
       });
     }
   });
 });
}

// Back-compat: single-shot run by prompt as positional argument.
// Accepts either a flat args object or an object with an "arguments" field (some hosts).
async function runCursorAgent(input, onProgress) {
  const source = (input && typeof input === 'object' && input.arguments && typeof input.prompt === 'undefined')
    ? input.arguments
    : input;

  const {
    prompt,
    output_format = 'text',
    extra_args,
    cwd,
    executable,
    model,
    force,
  } = source || {};

  const argv = [...(extra_args ?? []), String(prompt)];
  const usedPrompt = argv.length ? String(argv[argv.length - 1]) : '';

  // Optional prompt echo and debug diagnostics
  const debugEnv = getValidatedEnv();
  if (debugEnv.DEBUG_CURSOR_MCP) {
    try {
      const preview = usedPrompt.slice(0, 400).replace(/\n/g, '\\n');
      console.error('[cursor-mcp] prompt:', preview);
      if (extra_args?.length) console.error('[cursor-mcp] extra_args:', JSON.stringify(extra_args));
      if (model) console.error('[cursor-mcp] model:', model);
      if (typeof force === 'boolean') console.error('[cursor-mcp] force:', String(force));
    } catch {}
  }

  const result = await invokeCursorAgent({ argv, output_format, cwd, executable, model, force, onProgress });

  // Echo prompt either when env is set or when caller provided echo_prompt: true (if host forwards unknown args it's fine)
  const echoEnv = getValidatedEnv();
  const echoEnabled = echoEnv.CURSOR_AGENT_ECHO_PROMPT || source?.echo_prompt === true;
  if (echoEnabled) {
    const text = `Prompt used:\n${usedPrompt}`;
    const content = Array.isArray(result?.content) ? result.content : [];
    return { ...result, content: [{ type: 'text', text }, ...content] };
  }

  return result;
}

// Helper to create progress callback from extra context
function createProgressCallback(extra) {
  const progressToken = extra?._meta?.progressToken;
  const sendNotification = extra?.sendNotification;

  if (!progressToken || !sendNotification) {
    return undefined;
  }

  return async (progress) => {
    try {
      await sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: progress.progress,
          total: progress.total,
          message: progress.message
        }
      });
    } catch (e) {
      // Silently ignore progress notification errors
      const debugEnv = getValidatedEnv();
      if (debugEnv.DEBUG_CURSOR_MCP) {
        try {
          console.error('[cursor-mcp] progress notification error:', e);
        } catch {}
      }
    }
  };
}

// Use validated EXECUTING_CLIENT environment variable
const executingClient = getValidatedEnv().EXECUTING_CLIENT;

/**
* Create MCP server and register a suite of cursor-agent tools.
* We expose multiple verbs for better discoverability in hosts (chat/edit/analyze/search/plan),
* plus the legacy cursor_agent_run for back-compat and a raw escape hatch.
*/
const server = new McpServer(
 {
   name: 'cursor-agent',
   version: '1.1.0',
   description: 'MCP wrapper for cursor-agent CLI (multi-tool: chat/edit/analyze/search/plan/raw)',
 },
 {
   instructions:
     executingClient === 'cursor'
       ? [
           'Tools:',
           '- cursor_agent_chat: chat with a prompt; optional model/force/format.',
           '- cursor_agent_raw: pass raw argv directly to cursor-agent; set print=false to avoid implicit --print.',
         ].join('\n')
       : [
           'Tools:',
           '- cursor_agent_chat: chat with a prompt; optional model/force/format.',
           '- cursor_agent_edit_file: prompt-based file edit wrapper; you provide file and instruction.',
           '- cursor_agent_analyze_files: prompt-based analysis of one or more paths.',
           '- cursor_agent_search_repo: prompt-based code search with include/exclude globs.',
           '- cursor_agent_plan_task: prompt-based planning given a goal and optional constraints.',
           '- cursor_agent_raw: pass raw argv directly to cursor-agent; set print=false to avoid implicit --print.',
           '- cursor_agent_run: legacy single-shot chat (prompt as positional).',
         ].join('\n'),
 },
);

// Common shape used by multiple schemas
const COMMON = {
 output_format: z.enum(['text', 'json', 'markdown']).default('text'),
 extra_args: z.array(z.string()).optional(),
 cwd: z.string().optional(),
 executable: z.string().optional(),
 model: z.string().optional(),
 force: z.boolean().optional(),
 // When true, the server will prepend the effective prompt to the tool output (useful for Claude debugging)
 echo_prompt: z.boolean().optional(),
};

// Schemas
const CHAT_SCHEMA = z.object({
 prompt: z.string().min(1, 'prompt is required'),
 ...COMMON,
});

const EDIT_FILE_SCHEMA = z.object({
 file: z.string().min(1, 'file is required'),
 instruction: z.string().min(1, 'instruction is required'),
 apply: z.boolean().optional(),
 dry_run: z.boolean().optional(),
 // optional free-form prompt to pass if the CLI supports one
 prompt: z.string().optional(),
 ...COMMON,
});

const ANALYZE_FILES_SCHEMA = z.object({
  paths: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  prompt: z.string().optional(),
  ...COMMON,
});

const SEARCH_REPO_SCHEMA = z.object({
  query: z.string().min(1, 'query is required'),
  include: z.union([z.string(), z.array(z.string())]).optional(),
  exclude: z.union([z.string(), z.array(z.string())]).optional(),
  ...COMMON,
});

const PLAN_TASK_SCHEMA = z.object({
 goal: z.string().min(1, 'goal is required'),
 constraints: z.array(z.string()).optional(),
 ...COMMON,
});

const RAW_SCHEMA = z.object({
  // raw argv to pass after common flags; e.g., ["--help"] or ["subcmd","--flag"]
  argv: z.array(z.string()).min(1, 'argv must contain at least one element'),
  print: z.boolean().optional(),
  ...COMMON,
});

// Tools
server.tool(
  'cursor_agent_chat',
  'Chat with cursor-agent using a prompt and optional model/force/output_format.',
  CHAT_SCHEMA.shape,
  async (args, extra) => {
    try {
      // Normalize prompt in case the host nests under "arguments"
      const prompt =
        (args && typeof args === 'object' && 'prompt' in args ? args.prompt : undefined) ??
        (args && typeof args === 'object' && args.arguments && typeof args.arguments === 'object' ? args.arguments.prompt : undefined);

      const flat = {
        ...(args && typeof args === 'object' && args.arguments && typeof args.arguments === 'object' ? args.arguments : args),
        prompt,
      };

      const onProgress = createProgressCallback(extra);
      return await runCursorAgent(flat, onProgress);
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

// Raw escape hatch for power-users and forward compatibility
server.tool(
 'cursor_agent_raw',
 'Advanced: provide raw argv array to pass after common flags (e.g., ["search","--query","foo"]).',
 RAW_SCHEMA.shape,
 async (args, extra) => {
   try {
     const { argv, output_format, cwd, executable, model, force } = args;
     // For raw calls we disable implicit --print to allow commands like "--help"
     const onProgress = createProgressCallback(extra);
     return await invokeCursorAgent({ argv, output_format, cwd, executable, model, force, print: false, onProgress });
   } catch (e) {
     return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
   }
 },
);

// Register additional tools only when not called by cursor
if (executingClient !== 'cursor') {
  server.tool(
    'cursor_agent_edit_file',
    'Edit a file with an instruction. Prompt-based wrapper; no CLI subcommand required.',
    EDIT_FILE_SCHEMA.shape,
    async (args, extra) => {
      try {
        const { file, instruction, apply, dry_run, prompt, output_format, cwd, executable, model, force, extra_args } = args;
        const validatedFile = validateFilePath(file);
        const composedPrompt =
          `Edit the repository file:\n` +
          `- File: ${String(validatedFile)}\n` +
          `- Instruction: ${String(instruction)}\n` +
          (apply ? `- Apply changes if safe.\n` : `- Propose a patch/diff without applying.\n`) +
          (dry_run ? `- Treat as dry-run; do not write to disk.\n` : ``) +
          (prompt ? `- Additional context: ${String(prompt)}\n` : ``);
        const onProgress = createProgressCallback(extra);
        return await runCursorAgent({ prompt: composedPrompt, output_format, extra_args, cwd, executable, model, force }, onProgress);
      } catch (e) {
        return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
      }
    },
  );

  server.tool(
    'cursor_agent_analyze_files',
    'Analyze one or more paths; optional prompt. Prompt-based wrapper.',
    ANALYZE_FILES_SCHEMA.shape,
    async (args, extra) => {
      try {
        const { paths, prompt, output_format, cwd, executable, model, force, extra_args } = args;
        const list = Array.isArray(paths) ? paths : [paths];
        const validatedPaths = list.map((p) => validateFilePath(p));
        const composedPrompt =
          `Analyze the following paths in the repository:\n` +
          validatedPaths.map((p) => `- ${String(p)}`).join('\n') + '\n' +
          (prompt ? `Additional prompt: ${String(prompt)}\n` : '');
        const onProgress = createProgressCallback(extra);
        return await runCursorAgent({ prompt: composedPrompt, output_format, extra_args, cwd, executable, model, force }, onProgress);
      } catch (e) {
        return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
      }
    },
  );

  server.tool(
    'cursor_agent_search_repo',
    'Search repository code with include/exclude patterns. Prompt-based wrapper.',
    SEARCH_REPO_SCHEMA.shape,
    async (args, extra) => {
      try {
        const { query, include, exclude, output_format, cwd, executable, model, force, extra_args } = args;
        const inc = include == null ? [] : (Array.isArray(include) ? include : [include]);
        const exc = exclude == null ? [] : (Array.isArray(exclude) ? exclude : [exclude]);
        const composedPrompt =
          `Search the repository for occurrences relevant to:\n` +
          `- Query: ${String(query)}\n` +
          (inc.length ? `- Include globs:\n${inc.map((p)=>`  - ${String(p)}`).join('\n')}\n` : '') +
          (exc.length ? `- Exclude globs:\n${exc.map((p)=>`  - ${String(p)}`).join('\n')}\n` : '') +
          `Return concise findings with file paths and line references.`;
        const onProgress = createProgressCallback(extra);
        return await runCursorAgent({ prompt: composedPrompt, output_format, extra_args, cwd, executable, model, force }, onProgress);
      } catch (e) {
        return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
      }
    },
  );

  server.tool(
    'cursor_agent_plan_task',
    'Generate a plan for a goal with optional constraints. Prompt-based wrapper.',
    PLAN_TASK_SCHEMA.shape,
    async (args, extra) => {
      try {
        const { goal, constraints, output_format, cwd, executable, model, force, extra_args } = args;
        const cons = constraints ?? [];
        const composedPrompt =
          `Create a step-by-step plan to accomplish the following goal:\n` +
          `- Goal: ${String(goal)}\n` +
          (cons.length ? `- Constraints:\n${cons.map((c)=>`  - ${String(c)}`).join('\n')}\n` : '') +
          `Provide a numbered list of actions.`;
        const onProgress = createProgressCallback(extra);
        return await runCursorAgent({ prompt: composedPrompt, output_format, extra_args, cwd, executable, model, force }, onProgress);
      } catch (e) {
        return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
      }
    },
  );

  // Legacy single-shot prompt tool retained for compatibility
  server.tool(
   'cursor_agent_run',
   'Run cursor-agent with a prompt and desired output format (legacy single-shot).',
   RUN_SCHEMA.shape,
   async (args, extra) => {
     try {
       const onProgress = createProgressCallback(extra);
       return await runCursorAgent(args, onProgress);
     } catch (e) {
       return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
     }
   },
  );
}

// Connect using stdio transport
const transport = new StdioServerTransport();

server.connect(transport).catch((e) => {
 console.error('MCP server failed to start:', e);
 process.exit(1);
});
