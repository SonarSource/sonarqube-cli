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

import { SonarQubeClient } from '../../../../../sonarqube/client';
import { CommandFailedError, InvalidOptionError } from '../../../_common/error';
import { assertScaAvailable } from '../../../_common/sca-availability';
import {
  scaScannerBinaryDependency,
  sonarSecretsBinaryDependency,
} from '../../_common/registry/dependencies';
import { askUser, install, skip } from '../../_common/registry/selection';
import type { SubfeatureDeclaration } from '../../_common/registry/types';
import type { IntegrateGitOptions } from '../options';

export const PRE_COMMIT_DEP_RISKS_SUBFEATURE_ID = 'pre-commit-dependency-risks';

export function createSecretsSubfeature(): SubfeatureDeclaration<IntegrateGitOptions> {
  return {
    id: 'pre-commit-secrets',
    displayName: 'pre-commit secrets scan',
    shouldInstall: () =>
      install('Secrets scan is required for other hook types and is enabled by default'),
    dependencies: [sonarSecretsBinaryDependency],
  };
}

export function createDepRisksSubfeature(): SubfeatureDeclaration<IntegrateGitOptions> {
  return {
    id: PRE_COMMIT_DEP_RISKS_SUBFEATURE_ID,
    displayName: 'pre-commit dependency-risks scan',
    shouldInstall: async ({ options, scope, auth }) => {
      if (scope === 'global') {
        return skip('Dependency-risks scanning is not available for global hooks');
      }
      if (options.dependencyRisks && !options.project) {
        // explicit command parameter dependency-risks requires project to be resolved
        throw new InvalidOptionError('--dependency-risks requires -p <projectKey>.');
      }
      if (!options.project) {
        return skip('Dependency-risks scanning is not available without a project key.');
      }
      if (auth) {
        const client = new SonarQubeClient(auth.serverUrl, auth.token);
        try {
          await assertScaAvailable(client, auth);
        } catch (err) {
          if (err instanceof CommandFailedError) {
            return skip(err.message);
          }
          throw err;
        }
      }
      if (options.dependencyRisks) return install();
      return askUser('Enable dependency-risks scanning on the pre-commit hook?');
    },
    dependencies: [sonarSecretsBinaryDependency, scaScannerBinaryDependency],
  };
}
