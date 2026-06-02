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
import { intro, success, warn } from '../../../../ui';
import { InvalidOptionError } from '../../_common/error';
import {
  reportContextAugmentationFailure,
  resolveContextAugmentationSetup,
  setupContextAugmentation,
} from '../_common/context-augmentation';
import { CONTEXT_AUGMENTATION_FEATURE_ID } from '../_common/features/context-augmentation-skill-feature';
import { installIntegration } from '../_common/registry';
import { resolveSqaaEntitlement } from '../_common/sqaa-entitlement';
import type { IntegrateAgentOptions } from '../_common/types';
import { CODEX_INTEGRATION_ID, type CodexIntegrationOptions } from './declaration';

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
  const includeSqaa = !isGlobal && sqaaEligible && Boolean(projectKey);

  const installRoot = isGlobal ? homedir() : project.rootDir;
  const installScope: IntegrationScope = isGlobal ? 'global' : 'project';
  const integrationOptions = {
    ...options,
    installSecretsHooks: true,
    installSecretsInstructions: true,
    installSqaaInstructions: includeSqaa,
    installMcp: true,
    installContextAugmentationSkill: false,
  } satisfies CodexIntegrationOptions;

  await installIntegration({
    integrationId: CODEX_INTEGRATION_ID,
    options: integrationOptions,
    targetRoot: installRoot,
    scope: installScope,
    attrs: buildAttrs({
      includeSecretsSection: true,
      projectKey,
      includeSqaa,
    }),
  });

  if (!options.skipContext) {
    const contextAugmentation = await resolveContextAugmentationSetup({
      auth,
      projectKey,
      isGlobal,
    });
    if (contextAugmentation) {
      try {
        await installIntegration({
          integrationId: CODEX_INTEGRATION_ID,
          options: {
            ...integrationOptions,
            installContextAugmentationSkill: true,
          },
          targetRoot: project.rootDir,
          scope: 'project',
          featureIds: [CONTEXT_AUGMENTATION_FEATURE_ID],
          attrs: buildContextAugmentationAttrs(auth, projectKey, contextAugmentation.scaEnabled),
        });
        await setupContextAugmentation({
          auth,
          agentId: 'codex',
          projectRoot: project.rootDir,
          projectKey,
          scaEnabled: contextAugmentation.scaEnabled,
        });
      } catch (error) {
        reportContextAugmentationFailure(error);
        warn('Context Augmentation skill setup failed. Skipping tool integration.');
      }
    }
  }

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
  includeSqaa: boolean;
}): Record<string, IntegrationStateAttribute> {
  return {
    includeSecretsSection: args.includeSecretsSection,
    projectKey: args.projectKey ?? null,
    includeSqaa: args.includeSqaa,
  };
}

function buildContextAugmentationAttrs(
  auth: ResolvedAuth,
  projectKey: string | undefined,
  scaEnabled: boolean,
): Record<string, IntegrationStateAttribute> {
  return {
    orgKey: auth.orgKey ?? null,
    projectKey: projectKey ?? null,
    serverUrl: auth.serverUrl,
    scaEnabled,
  };
}
