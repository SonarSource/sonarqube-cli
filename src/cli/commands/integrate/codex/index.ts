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

// Integrate command — setup SonarQube integration for Codex.

import { homedir } from 'node:os';

import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import { discoverProject } from '../../../../lib/project-workspace';
import type { IntegrationScope, IntegrationStateAttribute } from '../../../../lib/state';
import { intro, print, success, warn } from '../../../../ui';
import { InvalidOptionError } from '../../_common/error';
import { installIntegration } from '../_common/registry';
import { resolveSqaaEntitlement } from '../_common/sqaa-entitlement';
import type { IntegrateAgentOptions } from '../_common/types';
import { CODEX_INTEGRATION_ID, registerCodexIntegration } from './declaration';

registerCodexIntegration();

export async function integrateCodex(
  options: IntegrateAgentOptions,
  auth: ResolvedAuth,
): Promise<void> {
  if (options.global && options.project) {
    throw new InvalidOptionError(
      '--global and --project are mutually exclusive; please specify only one scope.',
    );
  }

  intro('SonarQube integration for Codex');

  const project = await discoverProject(process.cwd());
  for (const configSource of project.configSources) {
    print(`Found ${configSource}`);
  }

  const isGlobal = options.global ?? false;
  const projectKey = options.project || project.projectKey;
  if (!isGlobal && !projectKey) {
    warn(
      'No project key provided - project related actions will be skipped. Run `sonar integrate codex --help` for ways to define a project.',
    );
  }

  // SQAA is always project-scoped:
  //  - project install: include the SQAA section if the org is entitled AND
  //    we know a project key.
  //  - global install: don't write SQAA anywhere, but if the org is entitled
  //    surface a hint pointing the user at the per-project command. We skip
  //    the warning for unentitled orgs to avoid noise about a feature they
  //    cannot use.
  const sqaaEligible = await resolveSqaaEntitlement(auth.serverUrl, auth.token, auth.orgKey);
  const sqaaProjectKey = !isGlobal && sqaaEligible && projectKey ? projectKey : undefined;

  const installRoot = isGlobal ? homedir() : project.rootDir;
  const installScope: IntegrationScope = isGlobal ? 'global' : 'project';

  const includeSqaaSection = sqaaProjectKey !== undefined;

  await installIntegration({
    integrationId: CODEX_INTEGRATION_ID,
    options: {
      ...options,
      installBinary: true,
      installSecretsHooks: true,
      installSecretsInstructions: true,
      installSqaaInstructions: includeSqaaSection,
    },
    targetRoot: installRoot,
    scope: installScope,
    attrs: buildAttrs({ includeSecretsSection: true, projectKey: sqaaProjectKey }),
  });

  if (isGlobal) {
    success('Codex integration successfully configured globally');
    if (sqaaEligible) {
      warn(
        'SonarQube Agentic Analysis is project-scoped and is not enabled by this global install. Run `sonar integrate codex --project <key>` from a project directory to enable it for that project.',
      );
    }
  } else {
    success('Codex integration successfully configured at the project level');
  }
}

function buildAttrs(args: {
  includeSecretsSection: boolean;
  projectKey: string | undefined;
}): Record<string, IntegrationStateAttribute> {
  return {
    includeSecretsSection: args.includeSecretsSection,
    projectKey: args.projectKey ?? null,
  };
}
