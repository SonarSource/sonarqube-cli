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

import { describe, expect, it, mock } from 'bun:test';

describe('matchesContextAugmentationTool', () => {
  it('matches every tool in the CAG matcher', async () => {
    const { matchesContextAugmentationTool } =
      await import('@/commands/hook/context-augmentation-hook-subscriber.ts');
    for (const tool of ['Bash', 'PowerShell', 'Monitor', 'Read']) {
      expect(matchesContextAugmentationTool(tool)).toBe(true);
    }
  });

  it('does not match SQAA-owned tools', async () => {
    const { matchesContextAugmentationTool } =
      await import('@/commands/hook/context-augmentation-hook-subscriber.ts');
    expect(matchesContextAugmentationTool('Edit')).toBe(false);
    expect(matchesContextAugmentationTool('Write')).toBe(false);
  });
});

describe('contextAugmentationPostToolUseSubscriber', () => {
  it('forwards raw stdin to CAG and reports handled', async () => {
    const runContextPassthroughMock = mock(() => Promise.resolve());
    void mock.module('@/commands/context/index.ts', () => ({
      runContextPassthrough: runContextPassthroughMock,
    }));

    const { contextAugmentationPostToolUseSubscriber } =
      await import('@/commands/hook/context-augmentation-hook-subscriber.ts');

    const result = await contextAugmentationPostToolUseSubscriber.handle(
      { tool_name: 'Bash' },
      '{"tool_name":"Bash"}',
    );

    expect(result).toEqual({ decision: 'handled' });
    expect(runContextPassthroughMock).toHaveBeenCalledWith('__hook', ['Claude'], {
      stdinPayload: '{"tool_name":"Bash"}',
    });
  });

  it('swallows a forwarding failure and reports none instead of throwing', async () => {
    const runContextPassthroughMock = mock(() => Promise.reject(new Error('Not authenticated.')));
    void mock.module('@/commands/context/index.ts', () => ({
      runContextPassthrough: runContextPassthroughMock,
    }));

    const { contextAugmentationPostToolUseSubscriber } =
      await import('@/commands/hook/context-augmentation-hook-subscriber.ts');

    const result = await contextAugmentationPostToolUseSubscriber.handle(
      { tool_name: 'Bash' },
      '{"tool_name":"Bash"}',
    );

    expect(result).toEqual({ decision: 'none' });
  });
});
