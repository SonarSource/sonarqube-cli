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

import { normalizePath } from '../../../../../../lib/fs-utils';
import { spawnProcess } from '../../../../../../lib/process';
import { CommandFailedError } from '../../../../_common/error';
import {
  type FeatureDeclaration,
  type IntegrationDeclaration,
  SonarSourceBinary,
  sonarSourceBinary,
} from '../../../_common/registry';
import type { GitHookType, IntegrateGitOptions } from '../../options';
import { nativeGitHookResource } from './resource';

export const NATIVE_GIT_INTEGRATION_ID = 'native-git';
const GLOBAL_GIT_CONFIG_REMEDIATION_HINT =
  'Ensure git is installed and your global git configuration is writable, then retry.';

export const nativeGitIntegration: IntegrationDeclaration<IntegrateGitOptions> = {
  id: NATIVE_GIT_INTEGRATION_ID,
  displayName: 'Native Git integration',
  features: [createNativeGitFeature('pre-commit'), createNativeGitFeature('pre-push')],
};

function createNativeGitFeature(hook: GitHookType): FeatureDeclaration<IntegrateGitOptions> {
  return {
    id: `${hook}-hook`,
    displayName: `${hook} hook`,
    when: ({ options }) => options.hook === hook,
    resources: [
      sonarSourceBinary({
        id: 'sonar-secrets',
        displayName: 'sonar-secrets binary',
        binary: SonarSourceBinary.SonarSecrets,
      }),
      nativeGitHookResource({
        id: 'hook-file',
        displayName: `${hook} hook`,
        hook,
      }),
    ],
    operations: [
      {
        id: 'configure-global-hooks-path',
        displayName: 'global hooks path',
        shouldApply: ({ scope }) => scope === 'global',
        apply: ({ targetRoot }) => configureGlobalHooksPath(targetRoot),
      },
    ],
  };
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

export { installViaGitHooks } from './hooks';
export { getHookScript, getPreCommitHookScript, getPrePushHookScript } from './shell-fragments';
