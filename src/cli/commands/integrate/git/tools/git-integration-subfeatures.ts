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

import { InvalidOptionError } from '../../../_common/error';
import {
  scaScannerBinaryDependency,
  sonarSecretsBinaryDependency,
} from '../../_common/registry/dependencies';
import { askUser, install, skip } from '../../_common/registry/selection';
import type { SubfeatureDeclaration } from '../../_common/registry/types';
import type { IntegrateGitOptions } from '../options';

export function createSecretsSubfeature(): SubfeatureDeclaration<IntegrateGitOptions> {
  return {
    id: 'pre-commit-secrets',
    displayName: 'pre-commit secrets scan',
    shouldInstall: () => install(),
    dependencies: [sonarSecretsBinaryDependency],
  };
}

export function createDepRisksSubfeature(): SubfeatureDeclaration<IntegrateGitOptions> {
  return {
    id: 'pre-commit-dependency-risks',
    displayName: 'pre-commit dependency-risks scan',
    shouldInstall: ({ options, nonInteractive, scope }) => {
      if (scope === 'global') {
        return skip('Dependency-risks scanning is not available for global hooks');
      }
      if (options.dependencyRisks && !options.project) {
        throw new InvalidOptionError('--dependency-risks requires -p <projectKey>.');
      }
      if (!options.project) {
        return skip('Dependency-risks scanning is not available without a project key.');
      }
      if (options.dependencyRisks) return install();
      if (nonInteractive) return skip();
      return askUser('Enable dependency-risks scanning on the pre-commit hook?');
    },
    dependencies: [sonarSecretsBinaryDependency, scaScannerBinaryDependency],
  };
}
