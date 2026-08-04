/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { ClaudePostToolUseSubscriber } from '@/commands/hook/claude-hook-dispatch.ts';
import { runClaudePostToolUseDispatch } from '@/commands/hook/claude-hook-dispatch.ts';

const RAW_STDIN = '{}';

function postSubscriber(
  id: string,
  matcher: string,
  handle: ClaudePostToolUseSubscriber['handle'],
): ClaudePostToolUseSubscriber {
  return { id, matches: (toolName) => toolName === matcher, handle };
}

describe('runClaudePostToolUseDispatch', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('writes nothing when no subscriber produces context', async () => {
    await runClaudePostToolUseDispatch({ tool_name: 'Edit' }, RAW_STDIN, [
      postSubscriber('sqaa', 'Edit', () => Promise.resolve({ decision: 'none' })),
    ]);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('writes a single subscriber output unchanged (regression parity with today)', async () => {
    await runClaudePostToolUseDispatch({ tool_name: 'Edit' }, RAW_STDIN, [
      postSubscriber('sqaa', 'Edit', () =>
        Promise.resolve({ decision: 'context', additionalContext: 'No issues found' }),
      ),
    ]);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput).toEqual({
      hookEventName: 'PostToolUse',
      additionalContext: 'No issues found',
    });
  });

  it('combines additionalContext from every matching subscriber into one write', async () => {
    await runClaudePostToolUseDispatch({ tool_name: 'Bash' }, RAW_STDIN, [
      postSubscriber('sqaa', 'Bash', () =>
        Promise.resolve({ decision: 'context', additionalContext: 'from sqaa' }),
      ),
      postSubscriber('cag', 'Bash', () =>
        Promise.resolve({ decision: 'context', additionalContext: 'from cag' }),
      ),
    ]);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.additionalContext).toBe('from sqaa\n\nfrom cag');
  });

  it('only calls subscribers whose matcher matches this tool_name', async () => {
    const sqaaHandle = spyOn(
      { handle: () => Promise.resolve({ decision: 'none' as const }) },
      'handle',
    );
    await runClaudePostToolUseDispatch({ tool_name: 'Bash' }, RAW_STDIN, [
      postSubscriber('sqaa', 'Edit', sqaaHandle),
    ]);
    expect(sqaaHandle).not.toHaveBeenCalled();
  });

  it('a handled result short-circuits — the dispatcher writes nothing itself', async () => {
    const second = spyOn(
      { handle: () => Promise.resolve({ decision: 'none' as const }) },
      'handle',
    );
    await runClaudePostToolUseDispatch({ tool_name: 'Bash' }, RAW_STDIN, [
      postSubscriber('cag', 'Bash', () => Promise.resolve({ decision: 'handled' })),
      postSubscriber('other', 'Bash', second),
    ]);

    expect(second).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('discards, rather than flushes, context buffered before a later handled result', async () => {
    await runClaudePostToolUseDispatch({ tool_name: 'Bash' }, RAW_STDIN, [
      postSubscriber('sqaa', 'Bash', () =>
        Promise.resolve({ decision: 'context', additionalContext: 'from sqaa' }),
      ),
      postSubscriber('cag', 'Bash', () => Promise.resolve({ decision: 'handled' })),
    ]);

    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('forwards the raw stdin text to each subscriber', async () => {
    const handle = spyOn(
      { handle: () => Promise.resolve({ decision: 'none' as const }) },
      'handle',
    );
    await runClaudePostToolUseDispatch({ tool_name: 'Bash' }, RAW_STDIN, [
      postSubscriber('cag', 'Bash', handle),
    ]);
    expect(handle).toHaveBeenCalledWith({ tool_name: 'Bash' }, RAW_STDIN);
  });

  it('swallows a write failure instead of throwing', async () => {
    stdoutSpy.mockImplementation(() => {
      throw new Error('stdout closed');
    });

    await runClaudePostToolUseDispatch({ tool_name: 'Edit' }, RAW_STDIN, [
      postSubscriber('sqaa', 'Edit', () =>
        Promise.resolve({ decision: 'context', additionalContext: 'text' }),
      ),
    ]);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });
});
