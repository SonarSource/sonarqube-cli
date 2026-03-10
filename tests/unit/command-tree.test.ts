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

// Tests for src/cli/command-tree.ts — covers the analyze action arg parsing

import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import * as analyzeModule from '../../src/cli/commands/analyze/secrets';
import * as telemetry from '../../src/telemetry/index.js';
import { COMMAND_TREE } from '../../src/cli/command-tree.js';
import { setMockUi } from '../../src/ui/index.js';

describe('command-tree: analyze action (full pipeline)', () => {
  let analyzeFileSpy: ReturnType<typeof spyOn>;
  let storeEventSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    analyzeFileSpy = spyOn(analyzeModule, 'analyzeFile').mockResolvedValue(undefined);
    storeEventSpy = spyOn(telemetry, 'storeEvent').mockResolvedValue(undefined);
  });

  afterEach(() => {
    setMockUi(false);
    analyzeFileSpy.mockRestore();
    storeEventSpy.mockRestore();
  });

  it('calls analyzeFile with file and branch', async () => {
    await COMMAND_TREE.parseAsync([
      'node',
      'sonar',
      'analyze',
      '--file',
      'src/foo.ts',
      '--branch',
      'main',
    ]);

    expect(analyzeFileSpy).toHaveBeenCalledWith({ file: 'src/foo.ts', branch: 'main' });
  });

  it('passes undefined branch when --branch is omitted', async () => {
    await COMMAND_TREE.parseAsync(['node', 'sonar', 'analyze', '--file', 'src/bar.ts']);

    expect(analyzeFileSpy).toHaveBeenCalledWith({ file: 'src/bar.ts', branch: undefined });
  });

  it('passes undefined file when --file is omitted', async () => {
    await COMMAND_TREE.parseAsync(['node', 'sonar', 'analyze']);

    expect(analyzeFileSpy).toHaveBeenCalledWith({ file: undefined, branch: undefined });
  });
});
