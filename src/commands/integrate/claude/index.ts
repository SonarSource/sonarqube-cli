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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { installIntegration } from '@/core/framework/features';
import type { IntegrationStateAttribute } from '@/core/state/state.ts';
import { printAgentNonInteractiveAlternativeHint } from '@/core/ui/components/agent-prompt-hint.ts';
import { removeObsoleteHookArtifacts } from '@/core/update/claude-hooks-migration.ts';

import {
  displayAgentIntegratePrelude,
  resolveIntegrateInstallTarget,
} from '../_common/agent-integrate-prelude.ts';
import { buildRecordedIntegrationAttrs } from '../_common/context-augmentation.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { resolveVortexSetup } from '../_common/vortex.ts';
import { supportedIntegrations } from '../index.ts';
import { CLAUDE_INTEGRATION_ID, type ClaudeIntegrationOptions } from './declaration.ts';
import { detectGlobalSecretsHook } from './hooks.ts';

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
  if (!options.nonInteractive) {
    printAgentNonInteractiveAlternativeHint(
      'sonar integrate claude --non-interactive',
      'sonar integrate claude --non-interactive -g',
    );
  }

  const ctx = await displayAgentIntegratePrelude('Claude Code', 'claude', options, auth);

  const config = toConfigurationData(ctx);
  // Probe for a global Claude hook; warns on orphaned installs and returns
  // the hook dir when project-level secrets hooks should be skipped.
  const existingGlobalHookPath = ctx.isGlobal
    ? undefined
    : await detectGlobalSecretsHook(homedir());
  const skipSecretsHooks = !!existingGlobalHookPath;

  const vortex = await resolveVortexSetup({
    auth,
    projectKey: ctx.projectKey,
    isGlobal: ctx.isGlobal,
  });
  const featureAttrs = await buildRecordedIntegrationAttrs({
    baseAttrs: buildIntegrationAttrs(config),
    projectRoot: ctx.project.rootDir,
    serverUrl: config.serverURL,
    orgKey: config.organization,
    contextAugmentation: vortex,
  });
  const { installRoot, installScope } = resolveIntegrateInstallTarget(
    ctx.isGlobal,
    ctx.project.rootDir,
  );
  const integrationOptions = {
    ...options,
    projectRoot: ctx.project.rootDir,
    globalSecretsHookExists: skipSecretsHooks,
    installVortex: vortex !== null,
  } satisfies ClaudeIntegrationOptions;
  let installError: Error | undefined;
  try {
    await installIntegration({
      registry: supportedIntegrations,
      integrationId: CLAUDE_INTEGRATION_ID,
      options: integrationOptions,
      targetRoot: installRoot,
      scope: installScope,
      auth,
      attrs: featureAttrs,
      nonInteractive: options.nonInteractive,
      isFromRouter: options.isFromRouter,
    });
  } catch (error) {
    installError = error instanceof Error ? error : new Error(String(error));
  }
  await removeObsoleteHookArtifacts(ctx.project.rootDir);
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
