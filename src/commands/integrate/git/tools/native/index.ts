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

import { join } from 'node:path';

import { CommandFailedError } from '@/core/command-error.ts';
import { sonarSecretsBinaryDependency } from '@/core/framework/dependencies';
import type {
  FeatureContainer,
  FeatureDeclaration,
  IntegrationContext,
  IntegrationDeclaration,
} from '@/core/framework/features/types.ts';
import { wholeFile, wholeFileRemover } from '@/core/framework/resources';
import { resolveGitHooksDir } from '@/core/host/git/hooks.ts';
import { normalizePath } from '@/core/io/fs-utils.ts';
import { spawnProcess } from '@/core/process/process.ts';

import type { GitHookType, IntegrateGitOptions } from '../../options.ts';
import {
  createDepRisksSubfeature,
  createSecretsSubfeature,
  gitHookPreview,
} from '../git-integration-subfeatures.ts';
import {
  gitCombinedHookExample,
  gitHookExample,
  LEGACY_HOOK_MARKER,
  shouldInstallHook,
} from '../shared.ts';
import { getHookScript, getNativeHookMarker } from './shell-fragments.ts';

export const NATIVE_GIT_INTEGRATION_ID = 'native-git';
const GLOBAL_GIT_CONFIG_REMEDIATION_HINT =
  'Ensure git is installed and your global git configuration is writable, then retry.';
const OVERWRITE_REMEDIATION_HINT =
  'Re-run sonar integrate git with --force to replace the existing hook.';

export const nativeGitIntegration: IntegrationDeclaration<IntegrateGitOptions> = {
  id: NATIVE_GIT_INTEGRATION_ID,
  displayName: 'Native Git integration',
  features: [createNativeGitFeature('pre-commit'), createNativeGitFeature('pre-push')],
  combinedPostInstallExample: gitCombinedHookExample,
};

function createNativeGitFeature(
  hook: GitHookType,
): FeatureContainer<IntegrateGitOptions> | FeatureDeclaration<IntegrateGitOptions> {
  const base: FeatureDeclaration<IntegrateGitOptions> = {
    id: `${hook}-hook`,
    displayName: `${hook} code scanning hook`,
    previewDescription: gitHookPreview(hook),
    shouldInstall: ({ options }) => shouldInstallHook(hook, options),
    postInstallExample: gitHookExample(hook),
    resources: [
      wholeFile({
        id: 'hook-file',
        version: '1',
        displayName: `${hook} hook`,
        targetPath: (context) => resolveNativeGitHookPath(context, hook),
        content: (context) => getHookScript(hook, context),
        executable: true,
        requiresForce: true,
        managedMarker: getNativeHookMarker(hook),
        overwriteRemediationHint: OVERWRITE_REMEDIATION_HINT,
      }),
    ],
    operations: [
      {
        id: 'configure-global-hooks-path',
        version: '1',
        displayName: 'global hooks path',
        shouldApply: ({ scope }) => scope === 'global',
        apply: ({ targetRoot }) => configureGlobalHooksPath(targetRoot),
        undo: async ({ scope, targetRoot }) => {
          if (scope === 'global') {
            await unsetGlobalHooksPath(targetRoot);
          }
        },
      },
    ],
    legacyCleanups: [
      wholeFileRemover({
        id: 'hook-file',
        version: '0',
        targetPath: (context) => resolveNativeGitHookPath(context, hook),
        managedMarker: LEGACY_HOOK_MARKER,
      }),
    ],
  };

  if (hook === 'pre-commit') {
    return {
      ...base,
      subfeatures: [createSecretsSubfeature(), createDepRisksSubfeature()],
      defaultInstallSubfeatureIds: ['pre-commit-secrets'],
    } satisfies FeatureContainer<IntegrateGitOptions>;
  }

  // Pre-push: no subfeatures, dependency on the feature directly.
  return { ...base, dependencies: [sonarSecretsBinaryDependency] };
}

async function unsetGlobalHooksPath(expectedHooksDir: string): Promise<void> {
  // Only unset core.hooksPath when it still points at the directory we configured.
  // A user or another tool may have repointed it after the Sonar install; we must
  // not clobber a value we no longer own.
  const current = await spawnProcess('git', ['config', '--global', '--get', 'core.hooksPath']);
  if (current.exitCode !== 0) {
    // Exit code 1: the key is unset. Anything else: cannot read it — leave it alone.
    return;
  }
  if (normalizePath(current.stdout) !== normalizePath(expectedHooksDir)) {
    return;
  }

  let gitResult;
  try {
    gitResult = await spawnProcess('git', ['config', '--global', '--unset', 'core.hooksPath']);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandFailedError(`Failed to run git [${message}]`, {
      remediationHint: GLOBAL_GIT_CONFIG_REMEDIATION_HINT,
    });
  }

  if (gitResult.exitCode !== 0 && gitResult.exitCode !== 5) {
    const detail = [gitResult.stderr, gitResult.stdout].filter(Boolean).join('\n');
    throw new CommandFailedError(
      `'git config --global --unset core.hooksPath' failed (exit code ${gitResult.exitCode}): ${detail}`,
      { remediationHint: GLOBAL_GIT_CONFIG_REMEDIATION_HINT },
    );
  }
}

async function configureGlobalHooksPath(hooksDir: string): Promise<void> {
  let gitResult;
  try {
    gitResult = await spawnProcess('git', [
      'config',
      '--global',
      'core.hooksPath',
      normalizePath(hooksDir),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandFailedError(`Failed to run git [${message}]`, {
      remediationHint: GLOBAL_GIT_CONFIG_REMEDIATION_HINT,
    });
  }

  if (gitResult.exitCode !== 0) {
    const detail = [gitResult.stderr, gitResult.stdout].filter(Boolean).join('\n');
    throw new CommandFailedError(
      `'git config --global core.hooksPath' failed (exit code ${gitResult.exitCode}): ${detail}`,
      { remediationHint: GLOBAL_GIT_CONFIG_REMEDIATION_HINT },
    );
  }
}

async function resolveNativeGitHookPath(
  context: IntegrationContext,
  hook: GitHookType,
): Promise<string> {
  if (context.scope === 'global') {
    return join(context.targetRoot, hook);
  }
  return join(await resolveGitHooksDir(context.targetRoot), hook);
}

export {
  getHookScript,
  getNativeHookMarker,
  getRecognizedNativeMarkers,
} from './shell-fragments.ts';
