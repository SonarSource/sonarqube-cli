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

import { describe, expect, it } from 'bun:test';
import type { Command } from 'commander';

import { createCommandTree } from '@/commands/command-tree.ts';

const COMMAND_TREE = await createCommandTree();

function resolveCommand(path: string[]): Command {
  let current: Command = COMMAND_TREE;
  for (const segment of path) {
    const next = current.commands.find((command) => command.name() === segment);
    if (!next) {
      throw new Error(`Unknown command segment: ${segment}`);
    }
    current = next;
  }
  return current;
}

describe('createCommandTree', () => {
  it('still accepts the deprecated --project on post-tool-use hooks', () => {
    for (const cmd of ['claude-post-tool-use', 'codex-post-tool-use']) {
      const hook = resolveCommand(['hook', cmd]);
      // Metadata only: parse() would run the real hook handler (stdin, Sentry, telemetry).
      expect(hook.options.some((option) => option.long === '--project')).toBe(true);
    }
  });
});
