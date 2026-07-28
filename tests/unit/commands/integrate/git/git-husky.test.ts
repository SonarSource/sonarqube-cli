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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { ContainerIntegrationContext, ResourceDeclaration } from '@/core/framework/features';
import { getDefaultState } from '@/core/state/state.ts';

import {
  getHuskyBeginMarker,
  getHuskySnippetContent,
  huskyIntegration,
} from '../../../../../src/commands/integrate/git/tools/husky';
import { getHookScript } from '../../../../../src/commands/integrate/git/tools/native';
import { SONAR_HOOK_SKIP_SECRETS_MESSAGE } from '../../../../../src/commands/integrate/git/tools/shared.ts';

const TEMP_DIR = join(process.cwd(), 'tests', 'unit', '.git-husky-tmp');

/** Temp repo used to run generated pre-commit scripts (staged file -> sonar skip branch). */
const HOOK_RUN_DIR = join(process.cwd(), 'tests', 'unit', '.git-precommit-run-tmp');
const HOOK_RUN_SCRIPT = 'hook-under-test';

/** sonar not on PATH; keep /usr/bin for git + sh + xargs etc. */
const MINIMAL_HOOK_PATH = '/usr/bin:/bin';

function context(): ContainerIntegrationContext {
  return {
    state: getDefaultState('test'),
    targetRoot: TEMP_DIR,
    scope: 'global',
    executionMode: 'install',
    resolvedDependencies: new Map(),
    activeSubfeatures: [],
  };
}

function huskyHookResource(hook: 'pre-commit' | 'pre-push'): ResourceDeclaration {
  const feature = huskyIntegration.features.find((f) => f.id === `${hook}-hook`);
  const resource = feature?.resources?.[0];
  if (!resource) throw new Error(`husky ${hook} resource not found`);
  return resource;
}

function huskyHookPath(hook: 'pre-commit' | 'pre-push'): string {
  return join(TEMP_DIR, '.husky', hook);
}

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

describe('husky hook resource (textSnippet)', () => {
  beforeEach(() => {
    mkdirSync(TEMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  it('writes the snippet when the hook file does not exist', async () => {
    await huskyHookResource('pre-commit').apply(context());

    const content = readFileSync(huskyHookPath('pre-commit'), 'utf-8');
    expect(content).toContain(getHuskyBeginMarker('pre-commit'));
    expect(content).toContain(getHuskySnippetContent('pre-commit', context()));
  });

  it('appends the pre-commit snippet to an existing hook file that has no marker', async () => {
    mkdirSync(join(TEMP_DIR, '.husky'), { recursive: true });
    writeFileSync(huskyHookPath('pre-commit'), '#!/bin/sh\necho "existing hook"\n');

    await huskyHookResource('pre-commit').apply(context());

    const content = readFileSync(huskyHookPath('pre-commit'), 'utf-8');
    expect(content).toContain('existing hook');
    expect(content).toContain(getHuskyBeginMarker('pre-commit'));
    expect(content).toContain(getHuskySnippetContent('pre-commit', context()));
  });

  it('appends the pre-push snippet when hook type is pre-push', async () => {
    mkdirSync(join(TEMP_DIR, '.husky'), { recursive: true });
    writeFileSync(huskyHookPath('pre-push'), '#!/bin/sh\necho "existing hook"\n');

    await huskyHookResource('pre-push').apply(context());

    const content = readFileSync(huskyHookPath('pre-push'), 'utf-8');
    expect(content).toContain(getHuskyBeginMarker('pre-push'));
    expect(content).toContain(getHuskySnippetContent('pre-push', context()));
  });

  it('is idempotent: applying twice produces the same content', async () => {
    await huskyHookResource('pre-commit').apply(context());
    const afterFirst = readFileSync(huskyHookPath('pre-commit'), 'utf-8');

    await huskyHookResource('pre-commit').apply(context());

    expect(readFileSync(huskyHookPath('pre-commit'), 'utf-8')).toBe(afterFirst);
  });
});

const IS_WINDOWS = process.platform === 'win32';

describe('git-shell-fragments (pre-commit hook execution)', () => {
  beforeEach(() => {
    rmSync(HOOK_RUN_DIR, { recursive: true, force: true });
    initGitRepoWithStagedFile(HOOK_RUN_DIR);
  });

  afterEach(() => {
    rmSync(HOOK_RUN_DIR, { recursive: true, force: true });
  });

  it.skipIf(IS_WINDOWS).each([
    ['Husky snippet', () => getHuskySnippetContent('pre-commit', context())],
    ['native hook script', () => getHookScript('pre-commit', context())],
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
    expect(getHookScript('pre-push', context())).toContain(SONAR_HOOK_SKIP_SECRETS_MESSAGE);
    expect(getHuskySnippetContent('pre-push', context())).toContain(
      SONAR_HOOK_SKIP_SECRETS_MESSAGE,
    );
  });

  it.skipIf(IS_WINDOWS)(
    'regression: native script without || : after command -v fails under sh -e',
    () => {
      const buggy = getHookScript('pre-commit', context()).replace(
        'command -v sonar 2>/dev/null || :',
        'command -v sonar 2>/dev/null',
      );
      writeFileSync(join(HOOK_RUN_DIR, HOOK_RUN_SCRIPT), buggy.trimStart());
      const response = runWrittenHook(HOOK_RUN_DIR, HOOK_RUN_SCRIPT);
      expect(response.stdout.toString()).not.toContain(SONAR_HOOK_SKIP_SECRETS_MESSAGE);
      expect(response.exitCode).not.toBe(0);
    },
  );
});
