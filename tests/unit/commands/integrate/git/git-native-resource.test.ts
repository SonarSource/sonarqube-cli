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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CommandFailedError } from '@/core/command-error.ts';
import type { ContainerIntegrationContext, ResourceDeclaration } from '@/core/framework/features';
import { wholeFileRemover } from '@/core/framework/features';
import { getDefaultState } from '@/core/state/state.ts';

import {
  getHookScript,
  nativeGitIntegration,
} from '../../../../../src/commands/integrate/git/tools/native';
import { LEGACY_HOOK_MARKER } from '../../../../../src/commands/integrate/git/tools/shared.ts';

const TEMP_DIR = join(process.cwd(), 'tests', 'unit', '.git-native-resource-tmp');

/** The native git hook is now the generic wholeFile resource declared on the native integration. */
function nativeHookResource(hook: 'pre-commit' | 'pre-push'): ResourceDeclaration {
  const feature = nativeGitIntegration.features.find((f) => f.id === `${hook}-hook`);
  const resource = feature?.resources?.[0];
  if (!resource) {
    throw new Error(`native ${hook} resource not found`);
  }
  return resource;
}

function context(
  overrides: Partial<ContainerIntegrationContext> = {},
): ContainerIntegrationContext {
  return {
    state: getDefaultState('test'),
    targetRoot: TEMP_DIR,
    scope: 'global',
    executionMode: 'install',
    resolvedDependencies: new Map(),
    activeSubfeatures: [],
    ...overrides,
  };
}

describe('native git hook resource (wholeFile)', () => {
  beforeEach(() => {
    mkdirSync(TEMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  it('treats CRLF hook files as already applied', async () => {
    writeFileSync(
      join(TEMP_DIR, 'pre-commit'),
      getHookScript('pre-commit', context()).replace(/\n/g, '\r\n'),
      'utf-8',
    );

    expect(await nativeHookResource('pre-commit').isApplied(context())).toBe(true);
  });

  it('cleanup removes a legacy-marked hook; resource then writes fresh content', async () => {
    const hookPath = join(TEMP_DIR, 'pre-commit');
    writeFileSync(hookPath, `#!/bin/sh\n# ${LEGACY_HOOK_MARKER}\nold\n`, 'utf-8');

    // Simulate the cleanup step: wholeFileRemover removes the legacy file.
    const cleanup = wholeFileRemover({
      id: 'hook-file',
      version: '0',
      targetPath: hookPath,
      managedMarker: LEGACY_HOOK_MARKER,
    });
    await cleanup.remove(context());
    expect(existsSync(hookPath)).toBe(false);

    // Resource writes fresh content since the file is now gone.
    await nativeHookResource('pre-commit').apply(context());
    expect(readFileSync(hookPath, 'utf-8')).toBe(getHookScript('pre-commit', context()));
  });

  it('refuses to overwrite a foreign hook without --force', async () => {
    writeFileSync(join(TEMP_DIR, 'pre-commit'), '#!/bin/sh\necho mine\n', 'utf-8');

    expect.assertions(2);
    try {
      await nativeHookResource('pre-commit').apply(context());
    } catch (error) {
      expect(error).toBeInstanceOf(CommandFailedError);
      expect((error as CommandFailedError).message).toContain(
        'A different pre-commit hook already exists at',
      );
    }
  });

  it('overwrites a foreign hook when --force is set', async () => {
    writeFileSync(join(TEMP_DIR, 'pre-commit'), '#!/bin/sh\necho mine\n', 'utf-8');

    await nativeHookResource('pre-commit').apply(context({ force: true }));

    expect(readFileSync(join(TEMP_DIR, 'pre-commit'), 'utf-8')).toBe(
      getHookScript('pre-commit', context()),
    );
  });

  it('remove deletes a Sonar-managed hook file', async () => {
    const hookPath = join(TEMP_DIR, 'pre-commit');
    writeFileSync(hookPath, getHookScript('pre-commit', context()), { mode: 0o755 });

    await nativeHookResource('pre-commit').remove(context());

    expect(existsSync(hookPath)).toBe(false);
  });

  it('remove leaves a third-party hook file without the Sonar marker', async () => {
    const hookPath = join(TEMP_DIR, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho custom\n', { mode: 0o755 });

    await nativeHookResource('pre-commit').remove(context());

    expect(existsSync(hookPath)).toBe(true);
  });
});

describe('native git hook chaining to a pre-existing local hook', () => {
  it('includes the chain block for a global-scope pre-commit hook', () => {
    const script = getHookScript('pre-commit', context({ scope: 'global' }));

    expect(script).toContain('git rev-parse --git-common-dir');
    expect(script).toContain('SONAR_LOCAL_HOOK="$SONAR_GIT_DIR/hooks/pre-commit"');
    expect(script).toContain('"$SONAR_LOCAL_HOOK" "$@" || exit $?');
  });

  it('includes the chain block for a global-scope pre-push hook, using the pre-push path and marker', () => {
    const script = getHookScript('pre-push', context({ scope: 'global' }));

    expect(script).toContain('SONAR_LOCAL_HOOK="$SONAR_GIT_DIR/hooks/pre-push"');
    expect(script).toContain('sonar pre-push hook - installed by sonar integrate git');
  });

  it('captures stdin once and replays it to both the chained hook and the sonar command, for pre-push', () => {
    const script = getHookScript('pre-push', context({ scope: 'global' }));

    expect(script).toContain('SONAR_STDIN_CACHE=$(mktemp 2>/dev/null || :)');
    expect(script).toContain('cat > "$SONAR_STDIN_CACHE"');
    expect(script).toContain('"$SONAR_LOCAL_HOOK" "$@" < "$SONAR_STDIN_CACHE" || exit $?');
    expect(script).toContain('hook git-pre-push < "$SONAR_STDIN_CACHE"');
  });

  it('does not add stdin capture for pre-commit, which reads no stdin', () => {
    const script = getHookScript('pre-commit', context({ scope: 'global' }));

    expect(script).not.toContain('SONAR_STDIN_CACHE');
    expect(script).toContain('"$SONAR_LOCAL_HOOK" "$@" || exit $?');
    expect(script).toContain('hook git-pre-commit\n');
  });

  it('checks for both the current and legacy Sonar markers, so an old per-repo install is not double-chained', () => {
    const script = getHookScript('pre-commit', context({ scope: 'global' }));

    expect(script).toContain('sonar pre-commit hook - installed by sonar integrate git');
    expect(script).toContain(LEGACY_HOOK_MARKER);
  });

  it('omits the chain block entirely for a project-scope hook', () => {
    const script = getHookScript('pre-commit', context({ scope: 'project' }));

    expect(script).not.toContain('git rev-parse --git-common-dir');
    expect(script).not.toContain('SONAR_LOCAL_HOOK');
  });

  it('resolves the shared hooks dir from the common dir, not the worktree admin dir', () => {
    const script = getHookScript('pre-commit', context({ scope: 'global' }));

    expect(script).toContain('SONAR_GIT_DIR=$(git rev-parse --git-common-dir 2>/dev/null || :)');
  });
});
