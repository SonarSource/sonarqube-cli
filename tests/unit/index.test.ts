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

import { afterAll, describe, expect, it, mock, spyOn } from 'bun:test';
import * as postUpdate from '../../src/lib/post-update';

const runPostUpdateActionsSpy = spyOn(postUpdate, 'runPostUpdateActions').mockResolvedValue(
  undefined,
);

const parseMock = mock(() => {});
const parseAsyncMock = mock(async () => {});
void mock.module('../../src/cli/command-tree', () => ({
  COMMAND_TREE: { parse: parseMock, parseAsync: parseAsyncMock },
}));

await import('../../src/index');

afterAll(() => {
  runPostUpdateActionsSpy.mockRestore();
});

describe('index', () => {
  it('calls runPostUpdateActions on startup', () => {
    expect(runPostUpdateActionsSpy).toHaveBeenCalledTimes(1);
  });

  it('calls COMMAND_TREE.parse on startup', () => {
    expect(parseMock).toHaveBeenCalledTimes(1);
  });
});
