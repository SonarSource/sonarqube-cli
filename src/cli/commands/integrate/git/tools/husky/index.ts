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

import { sonarSecretsBinaryDependency } from '../../../_common/registry/dependencies';
import { textSnippet } from '../../../_common/registry/resources';
import type { FeatureDeclaration, IntegrationDeclaration } from '../../../_common/registry/types';
import type { GitHookType, IntegrateGitOptions } from '../../options';
import { gitHookExample, HOOK_MARKER } from '../shared';
import { getHuskySnippetContent } from './shell-fragments';

export const HUSKY_INTEGRATION_ID = 'husky';

export const huskyIntegration: IntegrationDeclaration<IntegrateGitOptions> = {
  id: HUSKY_INTEGRATION_ID,
  displayName: 'Husky integration',
  features: [createHuskyFeature('pre-commit'), createHuskyFeature('pre-push')],
};

function createHuskyFeature(hook: GitHookType): FeatureDeclaration<IntegrateGitOptions> {
  return {
    id: `${hook}-hook`,
    displayName: `${hook} hook`,
    shouldInstall: ({ options }) => options.hook === hook,
    postInstallExample: gitHookExample(hook),
    dependencies: [sonarSecretsBinaryDependency],
    resources: [
      textSnippet({
        id: 'hook-file',
        displayName: `${hook} hook`,
        // Husky hook files live under <gitRoot>/.husky even when Git routes hooks there via core.hooksPath.
        targetPath: (context) => join(context.targetRoot, '.husky', hook),
        executable: true,
        startMarker: `# ${HOOK_MARKER}`,
        endMarker: `# sonar:end husky-${hook}`,
        content: getHuskySnippetContent(hook).trimEnd(),
      }),
    ],
  };
}

export { installViaHusky } from './install';
export {
  getHuskyPreCommitSnippet,
  getHuskyPrePushSnippet,
  getHuskySnippet,
  getHuskySnippetContent,
} from './shell-fragments';
