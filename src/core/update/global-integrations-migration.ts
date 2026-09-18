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

import { existsSync } from 'node:fs';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import {
  type IntegrationDeclaration,
  integrationInstaller,
  makeContext,
} from '@/core/framework/features';
import { TELEMETRY_FLUSH_MODE_ENV } from '@/core/telemetry';
import type { Console } from '@/core/ui/console.ts';
import { QuietConsole } from '@/core/ui/quiet-console.ts';

import logger from '../observability/logger.ts';
import type { CliState } from '../state/state.ts';
import { loadState, saveStateKeepingInstalledDependencies } from '../state/state-repository.ts';
import type {
  AgentIntegrationHandler,
  AgentIntegrationHandlers,
  PostUpdateDependencies,
} from './post-update.ts';

/** One agent to migrate, and every project-scoped install recorded for it. */
interface AgentMigration {
  declaration: IntegrationDeclaration;
  handler: AgentIntegrationHandler;
  /** Recorded project `targetRoot`s, one per repository the agent was integrated into. */
  integrationTargets: ReadonlySet<string>;
}

export function hasProjectScopedAgentIntegrations(
  state: CliState,
  handlers: AgentIntegrationHandlers,
): boolean {
  return state.integrations.installed.some(
    (integration) =>
      integration.integrationId in handlers &&
      integration.features.some((feature) => feature.scope === 'project'),
  );
}

/**
 * Moves every agent integrated into a repository over to global scope: removes the project-scoped
 * artifacts, reruns the real `sonar integrate <agent>` handler with `--global`, then drops the
 * project records.
 *
 * Teardown runs first because a few features resolve the same path at both scopes (Antigravity's
 * MCP config), so removing them afterwards would delete what the global install just wrote. State
 * is pruned only once the install succeeds, leaving `migrateDeclarativeIntegrations` to restore the
 * project artifacts on failure.
 */
export async function migrateAgentIntegrationsToGlobalScope(
  deps: PostUpdateDependencies,
): Promise<void> {
  if (process.env[TELEMETRY_FLUSH_MODE_ENV]) {
    return;
  }

  const agentMigrations = collectAgentMigrations(loadState(), deps);
  if (agentMigrations.length === 0) {
    return;
  }

  const auth = await resolveAuthOrNull(deps);
  if (!auth) {
    return;
  }

  const quietConsole = new QuietConsole(deps.console);
  deps.console.info('Migrating agent integrations to global scope...');

  for (const agentMigration of agentMigrations) {
    const { displayName } = agentMigration.declaration;
    deps.console.info(`Migrating the ${displayName} integration to global scope...`);
    try {
      await uninstallProjectScopedArtifacts(agentMigration, quietConsole);
      await installIntegrationAtGlobalScope(agentMigration, auth, quietConsole, deps);
      pruneProjectScopedRecordsFromState(agentMigration.declaration.id);
      deps.console.info(`Moved the ${displayName} integration to global scope.`);
    } catch (error) {
      deps.console.error(
        `Could not move the ${displayName} integration to global scope: ${(error as Error).message}`,
      );
    }
  }

  deps.console.info('Finished migrating agent integrations to global scope.');
}

async function resolveAuthOrNull(deps: PostUpdateDependencies): Promise<ResolvedAuth | null> {
  const authResult = await deps.runtime.authResolver.resolveAuth();
  if (authResult.isErr()) {
    logger.debug(`Skipping the global-integrations migration: ${authResult.error.message}`);
    return null;
  }
  return authResult.value;
}

function collectAgentMigrations(state: CliState, deps: PostUpdateDependencies): AgentMigration[] {
  const agentMigrations: AgentMigration[] = [];
  for (const integration of state.integrations.installed) {
    const declaration = deps.supportedIntegrations.get(integration.integrationId);
    if (!declaration || !(integration.integrationId in deps.agentIntegrationHandlers)) {
      continue;
    }
    const handler = deps.agentIntegrationHandlers[integration.integrationId];
    const integrationTargets = new Set<string>();
    for (const feature of integration.features) {
      if (feature.scope === 'project') {
        integrationTargets.add(feature.targetRoot);
      }
    }
    if (integrationTargets.size > 0) {
      agentMigrations.push({ declaration, handler, integrationTargets });
    }
  }
  return agentMigrations;
}

async function uninstallProjectScopedArtifacts(
  agentMigration: AgentMigration,
  quietConsole: Console,
): Promise<void> {
  const state = loadState();
  for (const targetRoot of agentMigration.integrationTargets) {
    if (!existsSync(targetRoot)) {
      continue;
    }
    for (const feature of agentMigration.declaration.features) {
      const context = makeContext(
        state, // unused by removeFeature
        targetRoot,
        'project',
        'install', // execution mode, unused by removeFeature
        undefined, // auth, unused by removeFeature
        true, // force, unused by removeFeature
        undefined, // attrs, unused by every agent remover
        quietConsole,
      );
      await integrationInstaller.removeFeature(context, feature);
    }
  }
}

function installIntegrationAtGlobalScope(
  agentMigration: AgentMigration,
  auth: ResolvedAuth,
  quietConsole: Console,
  deps: PostUpdateDependencies,
): Promise<void> {
  const ctx = new CommandAuthenticatedInvocationContext(
    auth,
    quietConsole,
    undefined,
    deps.runtime,
  );
  return agentMigration.handler({ global: true, nonInteractive: true }, ctx);
}

/** Reloads state: the install saved its own copy, so anything held from before it is stale. */
function pruneProjectScopedRecordsFromState(integrationId: string): void {
  const state = loadState();
  const integration = state.integrations.installed.find(
    (entry) => entry.integrationId === integrationId,
  );
  if (!integration) {
    return;
  }
  integration.features = integration.features.filter((feature) => feature.scope !== 'project');
  if (integration.features.length === 0) {
    state.integrations.installed = state.integrations.installed.filter(
      (entry) => entry !== integration,
    );
  }
  saveStateKeepingInstalledDependencies(state);
}
