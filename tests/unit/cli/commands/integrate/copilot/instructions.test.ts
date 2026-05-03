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

import {
  detectGlobalPromptSecretsInstructions,
  installPromptSecretsInstructions,
} from '../../../../../../src/cli/commands/integrate/copilot/instructions';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../../../src/ui';

const INSTRUCTIONS_FILENAME = 'sonarqube.instructions.md';
const GLOBAL_PATH = join(homedir(), '.copilot', 'instructions', INSTRUCTIONS_FILENAME);

describe('detectGlobalPromptSecretsInstructions', () => {
  let existsSyncSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    existsSyncSpy?.mockRestore();
  });

  it('returns undefined and stays silent when the global instructions file does not exist', () => {
    existsSyncSpy = spyOn(nodeFs, 'existsSync').mockImplementation(
      (p: nodeFs.PathLike) => String(p) !== GLOBAL_PATH,
    );

    const result = detectGlobalPromptSecretsInstructions();

    expect(result).toBeUndefined();
    const noisy = getMockUiCalls().filter((c) => c.method === 'info');
    expect(noisy).toHaveLength(0);
  });

  it('returns the path and emits info(...) when the global instructions file exists', () => {
    existsSyncSpy = spyOn(nodeFs, 'existsSync').mockImplementation(
      (p: nodeFs.PathLike) => String(p) === GLOBAL_PATH,
    );

    const result = detectGlobalPromptSecretsInstructions();

    expect(result).toBe(GLOBAL_PATH);
    const infoCall = getMockUiCalls().find(
      (c) =>
        c.method === 'info' &&
        (c.args[0] as string).includes('Global prompt-secrets instructions already installed at') &&
        (c.args[0] as string).includes('Skipping project-level instructions to avoid duplication'),
    );
    expect(infoCall).toBeDefined();
  });
});

describe('installPromptSecretsInstructions', () => {
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

  it('project scope: writes the file, creates the dir, and body contains the protocol heading', async () => {
    await installPromptSecretsInstructions(projectRoot, false);

    const filePath = join(projectRoot, '.github', 'instructions', INSTRUCTIONS_FILENAME);
    expect(nodeFs.existsSync(filePath)).toBe(true);
    expect(statSync(filePath).isFile()).toBe(true);
    expect(statSync(join(projectRoot, '.github', 'instructions')).isDirectory()).toBe(true);
    const body = readFileSync(filePath, 'utf-8');
    expect(body).toContain('# SonarQube prompt-secrets protocol');
    expect(body).toContain('API keys and access tokens');
    expect(body).toContain('do not proceed');
    expect(body).toContain('rotate the leaked credential');
  });

  it('global scope: writes the file to ~/.copilot/instructions/ and creates the dir recursively', async () => {
    // Spy out fs calls to avoid polluting the real homedir.
    const mkdirSpy = spyOn(nodeFs, 'mkdirSync').mockReturnValue(undefined);
    const writeFileSpy = spyOn(fsPromises, 'writeFile').mockResolvedValue(undefined);

    try {
      await installPromptSecretsInstructions('/unused/project', true);

      const writeCall = (writeFileSpy.mock.calls as Array<[string, unknown, unknown]>).find(([p]) =>
        p.endsWith(INSTRUCTIONS_FILENAME),
      );
      expect(writeCall).toBeDefined();
      expect(writeCall?.[0]).toBe(GLOBAL_PATH);

      const expectedDir = join(homedir(), '.copilot', 'instructions');
      const dirCall = (mkdirSpy.mock.calls as Array<[string, unknown]>).find(
        ([p]) => p === expectedDir,
      );
      expect(dirCall).toBeDefined();
      expect(dirCall?.[1]).toEqual({ recursive: true });
    } finally {
      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
    }
  });
});
