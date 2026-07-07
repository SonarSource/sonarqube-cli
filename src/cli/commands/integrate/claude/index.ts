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

// Integrate command - setup SonarQube integration for Claude Code

import { homedir } from 'node:os';

import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import { OBSOLETE_A3S_MARKER, removeObsoleteHookArtifacts } from '../../../../lib/migration';
import type { IntegrationStateAttribute } from '../../../../lib/state';
import {
  displayAgentIntegratePrelude,
  resolveIntegrateInstallTarget,
} from '../_common/agent-integrate-prelude';
import {
  buildContextAugmentationAttrs,
  resolveContextAugmentationSetup,
} from '../_common/context-augmentation';
import { installIntegration } from '../_common/registry';
import { resolveSqaaSetup } from '../_common/sqaa-entitlement';
import type { IntegrateAgentOptions } from '../_common/types';
import { supportedIntegrations } from '../index.js';
import { CLAUDE_INTEGRATION_ID, type ClaudeIntegrationOptions } from './declaration';
import { detectGlobalSecretsHook } from './hooks';

export interface ConfigurationData {
  serverURL: string;
  projectKey: string | undefined;
  organization: string | undefined;
  token: string;
}

/**
 * Integrate command handler
 */
export async function integrateClaude(
  options: IntegrateAgentOptions,
  auth: ResolvedAuth,
): Promise<void> {
  const ctx = await displayAgentIntegratePrelude('Claude Code', 'claude', options, auth);

  const config = toConfigurationData(ctx);
  // Probe for a global Claude hook; warns on orphaned installs and returns
  // the hook dir when project-level secrets hooks should be skipped.
  const existingGlobalHookPath = ctx.isGlobal
    ? undefined
    : await detectGlobalSecretsHook(homedir());
  const skipSecretsHooks = !!existingGlobalHookPath;

  const sqaaEnabled = await resolveSqaaSetup({
    serverURL: config.serverURL,
    token: config.token,
    organization: config.organization,
    isGlobal: ctx.isGlobal,
  });

  const contextAugmentation = options.skipContext
    ? null
    : await resolveContextAugmentationSetup({
        auth: { ...auth, token: config.token },
        projectKey: ctx.projectKey,
        isGlobal: ctx.isGlobal,
      });
  const featureAttrs = {
    ...buildIntegrationAttrs(config),
    ...(contextAugmentation
      ? buildContextAugmentationAttrs(
          config.serverURL,
          config.organization,
          contextAugmentation.scaEnabled,
        )
      : {}),
  };
  const { installRoot, installScope } = resolveIntegrateInstallTarget(
    ctx.isGlobal,
    ctx.project.rootDir,
  );
  const integrationOptions = {
    ...options,
    projectRoot: ctx.project.rootDir,
    globalSecretsHookExists: skipSecretsHooks,
    installSqaaHook: sqaaEnabled && config.projectKey !== undefined,
    installSqaaInstructions: sqaaEnabled && config.projectKey !== undefined,
    installContextAugmentation: contextAugmentation !== null,
  } satisfies ClaudeIntegrationOptions;
  let installError: Error | undefined;
  try {
    await installIntegration({
      registry: supportedIntegrations,
      integrationId: CLAUDE_INTEGRATION_ID,
      options: integrationOptions,
      targetRoot: installRoot,
      scope: installScope,
      auth: { ...auth, token: config.token },
      attrs: featureAttrs,
      nonInteractive: options.nonInteractive,
      isFromRouter: options.isFromRouter,
    });
  } catch (error) {
    installError = error instanceof Error ? error : new Error(String(error));
  }
  await removeObsoleteHookArtifacts(ctx.project.rootDir, OBSOLETE_A3S_MARKER);
  if (installError) {
    throw installError;
  }
}

function toConfigurationData(ctx: {
  serverUrl: string;
  organization: string | undefined;
  projectKey: string | undefined;
  token: string;
}): ConfigurationData {
  return {
    serverURL: ctx.serverUrl,
    organization: ctx.organization,
    projectKey: ctx.projectKey,
    token: ctx.token,
  };
}

function buildIntegrationAttrs(
  config: ConfigurationData,
): Record<string, IntegrationStateAttribute> {
  return {
    projectKey: config.projectKey ?? null,
  };
}
