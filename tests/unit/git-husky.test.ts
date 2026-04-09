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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { installViaHusky } from '../../src/cli/commands/integrate/git/git-husky';
import {
  HOOK_MARKER,
  SONAR_HOOK_SKIP_SECRETS_MESSAGE,
  getHuskyPreCommitSnippet,
  getHuskyPrePushSnippet,
  getPreCommitHookScript,
  getPrePushHookScript,
} from '../../src/cli/commands/integrate/git/git-shell-fragments';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui';

const TEMP_DIR = join(process.cwd(), 'tests', 'unit', '.git-husky-tmp');
const HOOK_PATH = join(TEMP_DIR, 'pre-commit');

/** Temp repo used to run generated pre-commit scripts (staged file → sonar skip branch). */
const HOOK_RUN_DIR = join(process.cwd(), 'tests', 'unit', '.git-precommit-run-tmp');
const HOOK_RUN_SCRIPT = 'hook-under-test';

/** `sonar` not on PATH; keep `/usr/bin` for `git` + `sh` + `xargs` etc. */
const MINIMAL_HOOK_PATH = '/usr/bin:/bin';

function initGitRepoWithStagedFile(cwd: string) {
  mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) =>
    Bun.spawnSync(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' });
  git('init');
  const file = 'staged.txt';
  writeFileSync(join(cwd, file), 'x\n');
  git('add', file);
}

function runWrittenHook(cwd: string, scriptName: string) {
  return Bun.spawnSync(['sh', '-e', scriptName], {
    cwd,
    env: { ...process.env, PATH: MINIMAL_HOOK_PATH },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('installViaHusky', () => {
  beforeEach(() => {
    mkdirSync(TEMP_DIR, { recursive: true });
    setMockUi(true);
    clearMockUiCalls();
  });

  afterEach(() => {
    setMockUi(false);
    rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  it('writes the snippet when the hook file does not exist', async () => {
    await installViaHusky(HOOK_PATH, 'pre-commit');

    const content = readFileSync(HOOK_PATH, 'utf-8');
    expect(content).toContain(HOOK_MARKER);
  });

  it('appends the pre-commit snippet to an existing hook file that has no marker', async () => {
    writeFileSync(HOOK_PATH, '#!/bin/sh\necho "existing hook"\n');

    await installViaHusky(HOOK_PATH, 'pre-commit');

    const content = readFileSync(HOOK_PATH, 'utf-8');
    expect(content).toContain('existing hook');
    expect(content).toContain(HOOK_MARKER);
    expect(content).toContain(getHuskyPreCommitSnippet());
    expect(
      getMockUiCalls().some(
        (c) => c.method === 'success' && String(c.args[0]).includes('pre-commit'),
      ),
    ).toBe(true);
  });

  it('appends the pre-push snippet when hook type is pre-push', async () => {
    const hookPath = join(TEMP_DIR, 'pre-push');
    writeFileSync(hookPath, '#!/bin/sh\necho "existing hook"\n');

    await installViaHusky(hookPath, 'pre-push');

    const content = readFileSync(hookPath, 'utf-8');
    expect(content).toContain(getHuskyPrePushSnippet());
    expect(
      getMockUiCalls().some(
        (c) => c.method === 'success' && String(c.args[0]).includes('pre-push'),
      ),
    ).toBe(true);
  });

  it('does not write the file when the marker is already present', async () => {
    writeFileSync(HOOK_PATH, `#!/bin/sh\n# ${HOOK_MARKER}\necho "already installed"\n`);
    const before = readFileSync(HOOK_PATH, 'utf-8');

    await installViaHusky(HOOK_PATH, 'pre-commit');

    expect(readFileSync(HOOK_PATH, 'utf-8')).toBe(before);
    expect(getMockUiCalls().some((c) => c.method === 'info')).toBe(true);
    expect(getMockUiCalls().some((c) => c.method === 'success')).toBe(false);
  });
});

describe('git-shell-fragments (pre-commit hook execution)', () => {
  beforeEach(() => {
    rmSync(HOOK_RUN_DIR, { recursive: true, force: true });
    initGitRepoWithStagedFile(HOOK_RUN_DIR);
  });

  afterEach(() => {
    rmSync(HOOK_RUN_DIR, { recursive: true, force: true });
  });

  it.each([
    ['Husky snippet', getHuskyPreCommitSnippet],
    ['native hook script', getPreCommitHookScript],
  ] as const)(
    'with staged files and no sonar on PATH, %s exits 0 and skips secrets scan',
    (_, getScript) => {
      writeFileSync(join(HOOK_RUN_DIR, HOOK_RUN_SCRIPT), getScript().trimStart());
      const response = runWrittenHook(HOOK_RUN_DIR, HOOK_RUN_SCRIPT);
      expect(response.exitCode).toBe(0);
      expect(response.stdout.toString()).toContain(SONAR_HOOK_SKIP_SECRETS_MESSAGE);
    },
  );

  it('pre-push templates still include the skip message when sonar is missing', () => {
    expect(getPrePushHookScript()).toContain(SONAR_HOOK_SKIP_SECRETS_MESSAGE);
    expect(getHuskyPrePushSnippet()).toContain(SONAR_HOOK_SKIP_SECRETS_MESSAGE);
  });

  it('regression: native script without `|| :` after command -v fails under sh -e', () => {
    const buggy = getPreCommitHookScript().replace(
      'command -v sonar 2>/dev/null || :',
      'command -v sonar 2>/dev/null',
    );
    writeFileSync(join(HOOK_RUN_DIR, HOOK_RUN_SCRIPT), buggy.trimStart());
    const response = runWrittenHook(HOOK_RUN_DIR, HOOK_RUN_SCRIPT);
    expect(response.stdout.toString()).not.toContain(SONAR_HOOK_SKIP_SECRETS_MESSAGE);
    expect(response.exitCode).not.toBe(0);
  });
});
