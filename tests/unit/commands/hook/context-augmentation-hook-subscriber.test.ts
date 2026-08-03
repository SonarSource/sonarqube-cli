/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

const runContextPassthroughMock = mock(() => Promise.resolve());
void mock.module('@/commands/context/index.ts', () => ({
  runContextPassthrough: runContextPassthroughMock,
}));

const { contextAugmentationPostToolUseSubscriber, matchesContextAugmentationTool } =
  await import('../../../../src/commands/hook/context-augmentation-hook-subscriber.ts');

describe('matchesContextAugmentationTool', () => {
  it('matches each tool in the CAG matcher', () => {
    for (const tool of ['Bash', 'PowerShell', 'Monitor', 'Read']) {
      expect(matchesContextAugmentationTool(tool)).toBe(true);
    }
  });

  it('does not match tools outside the CAG matcher', () => {
    expect(matchesContextAugmentationTool('Edit')).toBe(false);
    expect(matchesContextAugmentationTool('Write')).toBe(false);
  });
});

describe('contextAugmentationPostToolUseSubscriber', () => {
  it('forwards the raw stdin payload to runContextPassthrough and reports handled', async () => {
    runContextPassthroughMock.mockClear();
    const result = await contextAugmentationPostToolUseSubscriber.handle(
      { tool_name: 'Bash' },
      '{"tool_name":"Bash"}',
    );

    expect(runContextPassthroughMock).toHaveBeenCalledWith('__hook', ['Claude'], {
      stdinPayload: '{"tool_name":"Bash"}',
    });
    expect(result).toEqual({ decision: 'handled' });
  });
});
