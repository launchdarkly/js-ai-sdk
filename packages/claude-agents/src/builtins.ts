import { NativeTool } from '@launchdarkly/ai-server';

/**
 * Claude Code built-in tool sentinels. Place any of these as a value in your
 * `toolHandlers` map to enable the corresponding native Claude capability.
 *
 * @example
 * ```ts
 * import { ClaudeWebSearch, ClaudeBash } from '@launchdarkly/ai-claude-agents';
 *
 * const response = await graph('my-flag', {
 *   context,
 *   handlers: [createClaudeAgentsHandler()],
 *   toolHandlers: {
 *     'web-search': ClaudeWebSearch,
 *     'run-bash':   ClaudeBash,
 *   },
 * }).invoke(userInput, context);
 * ```
 */

export const ClaudeBash = new NativeTool(Symbol('ClaudeBash'), 'Bash');
export const ClaudeRead = new NativeTool(Symbol('ClaudeRead'), 'Read');
export const ClaudeEdit = new NativeTool(Symbol('ClaudeEdit'), 'Edit');
export const ClaudeWrite = new NativeTool(Symbol('ClaudeWrite'), 'Write');
export const ClaudeGlob = new NativeTool(Symbol('ClaudeGlob'), 'Glob');
export const ClaudeGrep = new NativeTool(Symbol('ClaudeGrep'), 'Grep');
export const ClaudeWebFetch = new NativeTool(Symbol('ClaudeWebFetch'), 'WebFetch');
export const ClaudeWebSearch = new NativeTool(Symbol('ClaudeWebSearch'), 'WebSearch');
export const ClaudeTodoWrite = new NativeTool(Symbol('ClaudeTodoWrite'), 'TodoWrite');
export const ClaudeNotebookEdit = new NativeTool(Symbol('ClaudeNotebookEdit'), 'NotebookEdit');
