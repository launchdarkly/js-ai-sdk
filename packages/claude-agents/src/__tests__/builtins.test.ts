import { NativeTool } from '@launchdarkly/ai-server';
import { describe, expect, it } from 'vitest';
import {
  ClaudeBash,
  ClaudeEdit,
  ClaudeGlob,
  ClaudeGrep,
  ClaudeNotebookEdit,
  ClaudeRead,
  ClaudeTodoWrite,
  ClaudeWebFetch,
  ClaudeWebSearch,
  ClaudeWrite,
} from '../builtins.js';

const ALL_BUILTINS = [
  { export: ClaudeBash, toolName: 'Bash' },
  { export: ClaudeRead, toolName: 'Read' },
  { export: ClaudeEdit, toolName: 'Edit' },
  { export: ClaudeWrite, toolName: 'Write' },
  { export: ClaudeGlob, toolName: 'Glob' },
  { export: ClaudeGrep, toolName: 'Grep' },
  { export: ClaudeWebFetch, toolName: 'WebFetch' },
  { export: ClaudeWebSearch, toolName: 'WebSearch' },
  { export: ClaudeTodoWrite, toolName: 'TodoWrite' },
  { export: ClaudeNotebookEdit, toolName: 'NotebookEdit' },
];

describe('Claude built-in NativeTool sentinels', () => {
  it('every export is a NativeTool instance', () => {
    for (const { export: builtin } of ALL_BUILTINS) {
      expect(builtin).toBeInstanceOf(NativeTool);
    }
  });

  it.each(ALL_BUILTINS)('$toolName has the correct toolName', ({ export: builtin, toolName }) => {
    expect(builtin.toolName).toBe(toolName);
  });

  it('all id symbols are unique', () => {
    const ids = ALL_BUILTINS.map(({ export: b }) => b.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ALL_BUILTINS.length);
  });

  it('individual exports have the expected toolName values', () => {
    expect(ClaudeBash.toolName).toBe('Bash');
    expect(ClaudeRead.toolName).toBe('Read');
    expect(ClaudeEdit.toolName).toBe('Edit');
    expect(ClaudeWrite.toolName).toBe('Write');
    expect(ClaudeGlob.toolName).toBe('Glob');
    expect(ClaudeGrep.toolName).toBe('Grep');
    expect(ClaudeWebFetch.toolName).toBe('WebFetch');
    expect(ClaudeWebSearch.toolName).toBe('WebSearch');
    expect(ClaudeTodoWrite.toolName).toBe('TodoWrite');
    expect(ClaudeNotebookEdit.toolName).toBe('NotebookEdit');
  });
});
