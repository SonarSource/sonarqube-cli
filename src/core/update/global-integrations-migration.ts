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
import type { AgentIntegrationHandler, PostUpdateDependencies } from './post-update.ts';

/** These read Claude's hooks too, so a global install beside Claude Code makes the two conflict. */
const CLAUDE_ID = 'claude-code';
const AGENTS_SUPERSEDED_BY_CLAUDE = new Set(['cursor', 'copilot-cli']);

/**
 * One attempt per process: `sonar update` reruns the migration through its own hook, and the
 * post-update run may already have tried (and reported) it in the same invocation.
 */
let attemptedThisProcess = false;

/** One agent to migrate, and every project-scoped install recorded for it. */
interface AgentMigration {
  declaration: IntegrationDeclaration;
  handler: AgentIntegrationHandler;
  /** Recorded project `targetRoot`s, one per repository the agent was integrated into. */
  integrationTargets: ReadonlySet<string>;
  /** Only the project artifacts go: the agent is already global, or Claude Code took its place. */
  skipGlobalInstall: boolean;
}

/**
 * Migrates every agent integrated into a repository to global scope: removes the project-scoped
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
  if (process.env[TELEMETRY_FLUSH_MODE_ENV] || attemptedThisProcess) {
    return;
  }

  const agentMigrations = collectAgentMigrations(loadState(), deps);
  if (agentMigrations.length === 0) {
    return;
  }
  attemptedThisProcess = true;

  const auth = await resolveAuthOrNull(deps);
  if (!auth) {
    deps.console.warn(
      `Could not migrate your agent integrations to global scope: you are not logged in. ` +
        `Run 'sonar auth login', then 'sonar update', to retry.`,
    );
    return;
  }

  const quietConsole = new QuietConsole(deps.console);
  deps.console.info(
    'Removing your project-level agent integrations and reinstalling them globally...',
  );
  let anyFailed = false;

  for (const agentMigration of agentMigrations) {
    const migrated = agentMigration.skipGlobalInstall
      ? await removeProjectIntegrations(agentMigration, quietConsole, deps)
      : await removeProjectIntegrationsAndInstallGlobally(agentMigration, auth, quietConsole, deps);
    anyFailed = anyFailed || !migrated;
  }

  if (anyFailed) {
    deps.console.warn(`Some integrations were left at project scope. Run 'sonar update' to retry.`);
    return;
  }
  deps.console.info(
    "Done — your integrations are now global. Run 'sonar integrate' anytime to add or remove one.",
  );
}

/** Swallows throws: a failed migration must never abort the command that triggered it. */
export async function migrateAgentIntegrationsToGlobalScopeSafely(
  deps: PostUpdateDependencies,
): Promise<void> {
  try {
    await migrateAgentIntegrationsToGlobalScope(deps);
  } catch (error) {
    deps.console.warn(
      `Could not migrate agent integrations to global scope: ${(error as Error).message}. ` +
        `Run 'sonar update' to retry.`,
    );
  }
}

async function removeProjectIntegrations(
  agentMigration: AgentMigration,
  quietConsole: Console,
  deps: PostUpdateDependencies,
): Promise<boolean> {
  const { displayName } = agentMigration.declaration;
  deps.console.info(`Removing the project-scoped ${displayName} integration...`);
  try {
    await uninstallProjectScopedArtifacts(agentMigration, quietConsole);
    pruneProjectScopedRecordsFromState(agentMigration.declaration.id);
    deps.console.info(`Removed the project-scoped ${displayName} integration.`);
    return true;
  } catch (error) {
    deps.console.error(
      `Could not remove the project-scoped ${displayName} integration: ${(error as Error).message}`,
    );
    return false;
  }
}

async function removeProjectIntegrationsAndInstallGlobally(
  agentMigration: AgentMigration,
  auth: ResolvedAuth,
  quietConsole: Console,
  deps: PostUpdateDependencies,
): Promise<boolean> {
  const { displayName } = agentMigration.declaration;
  deps.console.info(`Migrating the ${displayName} integration to global scope...`);
  try {
    await uninstallProjectScopedArtifacts(agentMigration, quietConsole);
    await installIntegrationAtGlobalScope(agentMigration, auth, quietConsole, deps);
    pruneProjectScopedRecordsFromState(agentMigration.declaration.id);
    deps.console.info(`Migrated the ${displayName} integration to global scope.`);
    return true;
  } catch (error) {
    deps.console.error(
      `Could not migrate the ${displayName} integration to global scope: ${(error as Error).message}`,
    );
    return false;
  }
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
  // Any recorded Claude integration ends up global: it is either already there or migrated below.
  const claudeGoesGlobal = state.integrations.installed.some(
    (integration) => integration.integrationId === CLAUDE_ID,
  );
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
    if (integrationTargets.size === 0) {
      continue;
    }
    const supersededByClaude = claudeGoesGlobal && AGENTS_SUPERSEDED_BY_CLAUDE.has(declaration.id);
    if (supersededByClaude) {
      deps.console.warn(
        `Skipped the global ${declaration.displayName} integration: you have the Claude Code ` +
          `integration installed, and ${declaration.displayName} picks up its global hooks, so the ` +
          `two would conflict.`,
      );
    }
    agentMigrations.push({
      declaration,
      handler,
      integrationTargets,
      skipGlobalInstall:
        supersededByClaude || integration.features.some((feature) => feature.scope === 'global'),
    });
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
