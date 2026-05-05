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

import * as nodeFs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { installInstructions } from '../../../../../../src/cli/commands/integrate/copilot/instructions';
import { clearMockUiCalls, findMockUiCall, setMockUi } from '../../../../../../src/ui';

const INSTRUCTIONS_FILENAME = 'sonarqube.instructions.md';
const GLOBAL_PATH = join(homedir(), '.copilot', 'instructions', INSTRUCTIONS_FILENAME);
const PROJECT_REL = join('.github', 'instructions', INSTRUCTIONS_FILENAME);

/**
 * Run `fn` while `nodeFs.existsSync` reports the global instructions file as
 * present (`true`) or absent (`false`). The spy is restored before `fn`'s
 * return value is yielded, so any post-call assertion sees the real fs.
 */
async function withGlobalInstructionsExisting<T>(
  exists: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const spy = spyOn(nodeFs, 'existsSync').mockReturnValue(exists);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

describe('installInstructions', () => {
  let projectRoot: string;

  beforeEach(() => {
    setMockUi(true);
    projectRoot = mkdtempSync(join(tmpdir(), 'sonar-copilot-instructions-'));
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  describe('project scope', () => {
    it('performs project-level install when no global file exists, returning the project path', async () => {
      const result = await withGlobalInstructionsExisting(false, () =>
        installInstructions(projectRoot, false),
      );

      const expectedPath = join(projectRoot, PROJECT_REL);
      expect(result).toEqual({ instructionsPath: expectedPath, instructionsInstalled: true });
      expect(statSync(expectedPath).isFile()).toBe(true);
      const body = readFileSync(expectedPath, 'utf-8');
      expect(body).toContain('# SonarQube prompt-secrets protocol');
      expect(body).toContain('API keys and access tokens');
    });

    it('skips project install and returns the global path when a global file exists', async () => {
      const result = await withGlobalInstructionsExisting(true, () =>
        installInstructions(projectRoot, false),
      );

      expect(result).toEqual({ instructionsPath: GLOBAL_PATH, instructionsInstalled: false });
      expect(nodeFs.existsSync(join(projectRoot, PROJECT_REL))).toBe(false);
      expect(
        findMockUiCall('info', 'Global prompt-secrets instructions already installed at'),
      ).toBeDefined();
    });
  });

  // The global-scope tests would write under the real `~/.copilot/instructions`
  // dir; spy `mkdirSync`/`writeFile` at the describe level to swallow those
  // writes.
  describe('global scope', () => {
    let mkdirSpy: ReturnType<typeof spyOn>;
    let writeFileSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      mkdirSpy = spyOn(nodeFs, 'mkdirSync').mockReturnValue(undefined);
      writeFileSpy = spyOn(fsPromises, 'writeFile').mockResolvedValue(undefined);
    });

    afterEach(() => {
      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
    });

    it('performs a global install when no global file exists yet', async () => {
      const result = await withGlobalInstructionsExisting(false, () =>
        installInstructions('/unused/project', true),
      );

      expect(result).toEqual({ instructionsPath: GLOBAL_PATH, instructionsInstalled: true });
      expect(mkdirSpy).toHaveBeenCalledWith(join(homedir(), '.copilot', 'instructions'), {
        recursive: true,
      });
      expect(writeFileSpy).toHaveBeenCalledWith(GLOBAL_PATH, expect.any(String), 'utf-8');
    });

    it('short-circuits the existing-global detection (re-installs without "already installed" notice)', async () => {
      const result = await withGlobalInstructionsExisting(true, () =>
        installInstructions('/unused/project', true),
      );

      expect(result).toEqual({ instructionsPath: GLOBAL_PATH, instructionsInstalled: true });
      expect(
        findMockUiCall('info', 'Global prompt-secrets instructions already installed at'),
      ).toBeUndefined();
    });
  });
});
