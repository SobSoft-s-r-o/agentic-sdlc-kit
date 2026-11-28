import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HookPayloadError, normalizePayload, patchPaths } from '../../src/hooks/payload.js';
import { HOOK_EVENTS, HOOK_HARNESSES } from '../../src/hooks/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/hooks');

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Record<string, unknown>;
}

describe('hook constants', () => {
  it('lists the harnesses and events', () => {
    expect(HOOK_HARNESSES).toEqual(['claude', 'codex', 'gemini']);
    expect(HOOK_EVENTS).toEqual(['session-start', 'prompt', 'pre-tool']);
  });
});

describe('normalizePayload: Claude Code', () => {
  it('maps Write to an edit with its file_path', () => {
    const event = normalizePayload('claude', 'pre-tool', fixture('claude-pretool-write'));
    expect(event).toEqual({
      harness: 'claude',
      event: 'pre-tool',
      cwd: '/work/proj',
      sessionId: 'abc123',
      promptId: 'prompt-7',
      inSubagent: false,
      tool: { category: 'edit', name: 'Write', paths: ['/work/proj/src/a.ts'] },
    });
  });

  it('maps Edit to an edit and marks a payload with agent_id as inside a subagent', () => {
    const event = normalizePayload('claude', 'pre-tool', fixture('claude-pretool-in-subagent'));
    expect(event.tool).toEqual({ category: 'edit', name: 'Edit', paths: ['/work/proj/src/b.ts'] });
    expect(event.inSubagent).toBe(true);
  });

  it('reads the path of NotebookEdit from notebook_path', () => {
    const event = normalizePayload('claude', 'pre-tool', fixture('claude-pretool-notebook'));
    expect(event.tool).toEqual({ category: 'edit', name: 'NotebookEdit', paths: ['/work/proj/analysis/model.ipynb'] });
  });

  it('maps Bash to a shell call with its command', () => {
    const event = normalizePayload('claude', 'pre-tool', fixture('claude-pretool-bash'));
    expect(event.tool).toEqual({ category: 'shell', name: 'Bash', command: 'npm test' });
    expect(event.inSubagent).toBe(false);
  });

  it('maps PowerShell to a shell call', () => {
    const raw = { ...fixture('claude-pretool-bash'), tool_name: 'PowerShell', tool_input: { command: 'Get-Date' } };
    expect(normalizePayload('claude', 'pre-tool', raw).tool).toEqual({
      category: 'shell',
      name: 'PowerShell',
      command: 'Get-Date',
    });
  });

  it('maps Agent to a subagent with its role and model', () => {
    const event = normalizePayload('claude', 'pre-tool', fixture('claude-pretool-agent'));
    expect(event.tool).toEqual({ category: 'subagent', name: 'Agent', role: 'sdlc-reviewer', model: 'sonnet' });
  });

  it('also maps the older Task tool to a subagent, and leaves out a missing model', () => {
    const raw = { ...fixture('claude-pretool-agent'), tool_name: 'Task', tool_input: { subagent_type: 'explorer' } };
    const tool = normalizePayload('claude', 'pre-tool', raw).tool;
    expect(tool).toEqual({ category: 'subagent', name: 'Task', role: 'explorer' });
    expect(tool).not.toHaveProperty('model');
  });

  it('maps a tool outside the table to other', () => {
    const event = normalizePayload('claude', 'pre-tool', fixture('claude-pretool-read'));
    expect(event.tool).toEqual({ category: 'other', name: 'Read' });
  });

  it('gives prompt, session id and prompt id for a prompt event', () => {
    const event = normalizePayload('claude', 'prompt', fixture('claude-prompt'));
    expect(event).toEqual({
      harness: 'claude',
      event: 'prompt',
      cwd: '/work/proj',
      sessionId: 'abc123',
      promptId: 'prompt-7',
      prompt: 'Add a retry to the fetch helper.',
      inSubagent: false,
    });
  });

  it('gives the source of a session-start event', () => {
    const event = normalizePayload('claude', 'session-start', fixture('claude-session-start'));
    expect(event).toEqual({
      harness: 'claude',
      event: 'session-start',
      cwd: '/work/proj',
      sessionId: 'abc123',
      source: 'startup',
      inSubagent: false,
    });
  });
});

describe('normalizePayload: Codex CLI', () => {
  it('resolves every header path of an apply_patch against cwd', () => {
    const event = normalizePayload('codex', 'pre-tool', fixture('codex-pretool-apply-patch'));
    expect(event.tool).toEqual({
      category: 'edit',
      name: 'apply_patch',
      paths: ['/work/proj/hello.txt', '/work/proj/src/app.ts', '/work/proj/src/main.ts'],
    });
    expect(event.promptId).toBe('turn_1');
  });

  it('gives an edit without paths for an apply_patch without a patch', () => {
    const raw = { ...fixture('codex-pretool-apply-patch'), tool_input: {} };
    expect(normalizePayload('codex', 'pre-tool', raw).tool).toEqual({ category: 'edit', name: 'apply_patch', paths: [] });
  });

  it('maps Bash to a shell call with its command', () => {
    const event = normalizePayload('codex', 'pre-tool', fixture('codex-pretool-bash'));
    expect(event.tool).toEqual({ category: 'shell', name: 'Bash', command: 'npm test' });
    expect(event.sessionId).toBe('thr_123');
    expect(event.inSubagent).toBe(false);
  });

  it('accepts cmd where older versions send it instead of command', () => {
    const raw = { ...fixture('codex-pretool-bash'), tool_input: { cmd: 'git status' } };
    expect(normalizePayload('codex', 'pre-tool', raw).tool).toEqual({
      category: 'shell',
      name: 'Bash',
      command: 'git status',
    });
  });

  it('prefers command over cmd', () => {
    const raw = { ...fixture('codex-pretool-bash'), tool_input: { command: 'a', cmd: 'b' } };
    expect(normalizePayload('codex', 'pre-tool', raw).tool).toMatchObject({ command: 'a' });
  });

  it('maps spawn_agent to a subagent with its agent_type and no model', () => {
    const tool = normalizePayload('codex', 'pre-tool', fixture('codex-pretool-spawn-agent')).tool;
    expect(tool).toEqual({ category: 'subagent', name: 'spawn_agent', role: 'explorer' });
    expect(tool).not.toHaveProperty('model');
  });

  it('keeps the model of a spawn_agent that names one', () => {
    const raw = {
      ...fixture('codex-pretool-spawn-agent'),
      tool_input: { agent_type: 'worker', model: 'gpt-5-mini' },
    };
    expect(normalizePayload('codex', 'pre-tool', raw).tool).toEqual({
      category: 'subagent',
      name: 'spawn_agent',
      role: 'worker',
      model: 'gpt-5-mini',
    });
  });

  it('marks a payload with agent_id as inside a subagent', () => {
    expect(normalizePayload('codex', 'pre-tool', fixture('codex-pretool-in-subagent')).inSubagent).toBe(true);
  });

  it('gives prompt, session id and the turn id as prompt id', () => {
    const event = normalizePayload('codex', 'prompt', fixture('codex-prompt'));
    expect(event).toEqual({
      harness: 'codex',
      event: 'prompt',
      cwd: '/work/proj',
      sessionId: 'thr_123',
      promptId: 'turn_2',
      prompt: 'Explain the retry logic.',
      inSubagent: false,
    });
  });

  it('gives the source of a session-start event', () => {
    const event = normalizePayload('codex', 'session-start', fixture('codex-session-start'));
    expect(event.source).toBe('resume');
    expect(event.sessionId).toBe('thr_123');
  });

  it('maps a tool outside the table to other', () => {
    const raw = { ...fixture('codex-pretool-bash'), tool_name: 'mcp__docs__search' };
    expect(normalizePayload('codex', 'pre-tool', raw).tool).toEqual({ category: 'other', name: 'mcp__docs__search' });
  });
});

describe('normalizePayload: Gemini CLI', () => {
  it('resolves a relative write_file path against cwd', () => {
    const event = normalizePayload('gemini', 'pre-tool', fixture('gemini-pretool-write'));
    expect(event.tool).toEqual({ category: 'edit', name: 'write_file', paths: ['/work/proj/src/a.ts'] });
  });

  it('keeps an absolute replace path', () => {
    const event = normalizePayload('gemini', 'pre-tool', fixture('gemini-pretool-replace'));
    expect(event.tool).toEqual({ category: 'edit', name: 'replace', paths: ['/work/proj/src/c.ts'] });
  });

  it('maps run_shell_command to a shell call with its command', () => {
    const event = normalizePayload('gemini', 'pre-tool', fixture('gemini-pretool-shell'));
    expect(event.tool).toEqual({ category: 'shell', name: 'run_shell_command', command: 'npm test' });
  });

  it('maps invoke_agent to a subagent with its agent_name and no model', () => {
    const tool = normalizePayload('gemini', 'pre-tool', fixture('gemini-pretool-agent')).tool;
    expect(tool).toEqual({ category: 'subagent', name: 'invoke_agent', role: 'codebase_investigator' });
    expect(tool).not.toHaveProperty('model');
  });

  it('is never inside a subagent, even when the payload carries an agent_id', () => {
    const raw = { ...fixture('gemini-pretool-shell'), agent_id: 'x' };
    expect(normalizePayload('gemini', 'pre-tool', raw).inSubagent).toBe(false);
  });

  it('gives prompt and session id for BeforeAgent, with no prompt id', () => {
    const event = normalizePayload('gemini', 'prompt', fixture('gemini-prompt'));
    expect(event).toEqual({
      harness: 'gemini',
      event: 'prompt',
      cwd: '/work/proj',
      sessionId: '7f3e0001',
      prompt: 'Summarize the open TODOs.',
      inSubagent: false,
    });
  });

  it('gives the source of a session-start event', () => {
    const event = normalizePayload('gemini', 'session-start', fixture('gemini-session-start'));
    expect(event.source).toBe('startup');
  });

  it('maps a Claude tool name that Gemini does not use to other', () => {
    const raw = { ...fixture('gemini-pretool-shell'), tool_name: 'Bash' };
    expect(normalizePayload('gemini', 'pre-tool', raw).tool).toEqual({ category: 'other', name: 'Bash' });
  });
});

describe('normalizePayload: shape rules', () => {
  const base = fixture('claude-pretool-bash');

  it('ignores unknown extra fields', () => {
    const raw = { ...base, brand_new_field: { nested: true }, effort: 'high' };
    expect(normalizePayload('claude', 'pre-tool', raw)).toEqual(normalizePayload('claude', 'pre-tool', base));
  });

  it('reads only the fields of the requested event', () => {
    const event = normalizePayload('claude', 'session-start', { ...base, prompt: 'x', source: 'resume' });
    expect(event.source).toBe('resume');
    expect(event).not.toHaveProperty('prompt');
    expect(event).not.toHaveProperty('tool');
  });

  it('leaves the ids out when the payload has none', () => {
    const event = normalizePayload('claude', 'prompt', { cwd: '/work/proj', prompt: 'hi' });
    expect(event).toEqual({ harness: 'claude', event: 'prompt', cwd: '/work/proj', prompt: 'hi', inSubagent: false });
  });

  it('treats an empty agent_id as absent', () => {
    expect(normalizePayload('claude', 'pre-tool', { ...base, agent_id: '' }).inSubagent).toBe(false);
  });

  it('does not take a tool name from the object prototype', () => {
    const tool = normalizePayload('claude', 'pre-tool', { ...base, tool_name: 'constructor' }).tool;
    expect(tool).toEqual({ category: 'other', name: 'constructor' });
  });

  it.each([
    ['null', null],
    ['a string', 'text'],
    ['a number', 7],
    ['an array', [{ cwd: '/work/proj' }]],
    ['undefined', undefined],
  ])('rejects a payload that is %s', (_label, raw) => {
    expect(() => normalizePayload('claude', 'prompt', raw)).toThrow(HookPayloadError);
  });

  it('rejects a payload without cwd', () => {
    const { cwd: _cwd, ...raw } = base;
    expect(() => normalizePayload('claude', 'pre-tool', raw)).toThrow(HookPayloadError);
    expect(() => normalizePayload('claude', 'pre-tool', raw)).toThrow(/cwd/);
  });

  it.each([
    ['empty', ''],
    ['relative', 'work/proj'],
    ['dot', '.'],
    ['not a string', 42],
  ])('rejects a cwd that is %s', (_label, cwd) => {
    expect(() => normalizePayload('claude', 'pre-tool', { ...base, cwd })).toThrow(HookPayloadError);
  });

  it('rejects a pre-tool payload without tool_name', () => {
    const { tool_name: _name, ...raw } = base;
    expect(() => normalizePayload('claude', 'pre-tool', raw)).toThrow(HookPayloadError);
    expect(() => normalizePayload('claude', 'pre-tool', raw)).toThrow(/tool_name/);
  });

  it('does not need tool_name for the other events', () => {
    const { tool_name: _name, ...raw } = base;
    expect(normalizePayload('claude', 'session-start', raw).tool).toBeUndefined();
  });

  it('gives a shell call with an empty command when the payload names none', () => {
    const raw = { ...base, tool_input: undefined };
    expect(normalizePayload('claude', 'pre-tool', raw).tool).toEqual({ category: 'shell', name: 'Bash', command: '' });
  });

  it('gives an edit without paths when the payload names no file', () => {
    const raw = { ...base, tool_name: 'Write', tool_input: { content: 'x' } };
    expect(normalizePayload('claude', 'pre-tool', raw).tool).toEqual({ category: 'edit', name: 'Write', paths: [] });
  });

  it('is an error the CLI can name', () => {
    const error = new HookPayloadError('boom');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('HookPayloadError');
  });
});

describe('patchPaths', () => {
  it('lists the paths of every header in order', () => {
    const patch = '*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n*** Delete File: c.ts\n*** End Patch';
    expect(patchPaths(patch)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('reads Add File headers and skips content lines', () => {
    const patch = '*** Begin Patch\n*** Add File: docs/new.md\n+# Title\n+*** Add File: not-a-header\n*** End Patch';
    expect(patchPaths(patch)).toEqual(['docs/new.md']);
  });

  it('lists a path once', () => {
    const patch = '*** Update File: a.ts\n@@\n-x\n+y\n*** Update File: a.ts\n@@\n-p\n+q\n*** Move to: a.ts';
    expect(patchPaths(patch)).toEqual(['a.ts']);
  });

  it('copes with CRLF line endings and padded headers', () => {
    const patch = '*** Begin Patch\r\n  *** Update File:   src/a b.ts  \r\n@@\r\n-x\r\n+y\r\n*** End Patch\r\n';
    expect(patchPaths(patch)).toEqual(['src/a b.ts']);
  });

  it('keeps absolute paths as written', () => {
    expect(patchPaths('*** Add File: /etc/hosts\n+x')).toEqual(['/etc/hosts']);
  });

  it('gives nothing for text without headers or with an empty path', () => {
    expect(patchPaths('')).toEqual([]);
    expect(patchPaths('just some text')).toEqual([]);
    expect(patchPaths('*** Add File:   \n+x')).toEqual([]);
  });
});
