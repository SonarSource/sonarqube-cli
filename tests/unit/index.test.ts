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

import { mock, describe, it, expect } from 'bun:test';

const runPostUpdateActionsMock = mock(async () => {});
void mock.module('../../src/lib/post-update', () => ({
  runPostUpdateActions: runPostUpdateActionsMock,
}));

const parseMock = mock(() => {});
void mock.module('../../src/cli/command-tree', () => ({
  COMMAND_TREE: { parse: parseMock },
}));

await import('../../src/index');

describe('index', () => {
  it('calls runPostUpdateActions on startup', () => {
    expect(runPostUpdateActionsMock).toHaveBeenCalledTimes(1);
  });

  it('calls COMMAND_TREE.parse on startup', () => {
    expect(parseMock).toHaveBeenCalledTimes(1);
  });
});
