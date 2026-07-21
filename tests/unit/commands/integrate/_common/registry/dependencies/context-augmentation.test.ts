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

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type { IntegrationContext } from '../../../../../../../src/commands/integrate/_common/registry';

let binaryPath: string | null = null;
const stopCalls: { path: string; existedAtCall: boolean }[] = [];

const installModule =
  await import('../../../../../../../src/commands/_common/install/context-augmentation.ts');
await mock.module(
  '../../../../../../../src/commands/_common/install/context-augmentation.ts',
  () => ({
    ...installModule,
    resolveContextAugmentationBinaryPath: () => binaryPath,
  }),
);

const integrateCagModule =
  await import('../../../../../../../src/commands/integrate/_common/context-augmentation.ts');
await mock.module(
  '../../../../../../../src/commands/integrate/_common/context-augmentation.ts',
  () => ({
    ...integrateCagModule,
    stopAllContextAugmentationTools: (path: string) => {
      stopCalls.push({ path, existedAtCall: existsSync(path) });
      return Promise.resolve(true);
    },
  }),
);

const { contextAugmentationBinaryDependency } =
  await import('../../../../../../../src/commands/integrate/_common/registry/dependencies/context-augmentation.ts');

const context = {} as IntegrationContext;

describe('ContextAugmentationBinaryDependency.remove', () => {
  let binDir: string;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), 'sonar-cli-cag-'));
    binaryPath = null;
    stopCalls.length = 0;
  });

  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  it('stops the running tools and then deletes the binary', async () => {
    const path = join(binDir, 'sonar-context-augmentation');
    writeFileSync(path, 'binary');
    binaryPath = path;

    await contextAugmentationBinaryDependency.remove(context);

    // The daemon must be stopped before the file is removed, otherwise we would
    // delete a binary that is still running.
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]?.path).toBe(path);
    expect(stopCalls[0]?.existedAtCall).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('is a no-op when the binary is not installed', async () => {
    binaryPath = null;

    await contextAugmentationBinaryDependency.remove(context);

    expect(stopCalls).toHaveLength(0);
  });
});
