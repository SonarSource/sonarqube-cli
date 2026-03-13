/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Auto-migration for Claude Code hooks configuration.
// This migration logic is invoked explicitly from the integrate command.
// It should eventually become part of a dedicated post-update mechanism that
// runs automatically after CLI upgrades, to be implemented in a future iteration.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import logger from './logger';
import {
  loadState,
  saveState,
  addInstalledHook,
  upsertAgentExtension,
  getActiveConnection,
} from './state-manager';
import type { HookExtension } from './state';
import { installHooks } from '../cli/commands/integrate/claude/hooks';
import { version as CURRENT_VERSION } from '../../package.json';

// Version that introduced the new hook architecture (separate secrets/A3S hooks)
const NEW_HOOK_ARCH_VERSION = CURRENT_VERSION;

// Version known to have the CLI-105 state deduplication bug
const CLI_105_AFFECTED_VERSION = '0.5.1';

/**
 * Run all pending config migrations for Claude Code agent.
 * Called during sonar claude setup. Non-blocking — logs and continues on error.
 */
export async function runMigrations(
  projectRoot: string,
  globalDir?: string,
  installA3s = false,
  projectKey?: string,
): Promise<void> {
  try {
    const state = loadState();
    const agentConfig = state.agents['claude-code'];

    if (!agentConfig.configured) {
      return;
    }

    const installedVersion = agentConfig.configuredByCliVersion;
    if (!installedVersion) {
      return;
    }

    if (installedVersion === NEW_HOOK_ARCH_VERSION) {
      return;
    }

    logger.debug(
      `Migrating Claude Code hooks from v${installedVersion} to v${NEW_HOOK_ARCH_VERSION}`,
    );

    // CLI-105 patch: v0.5.1 only registered UserPromptSubmit due to dedup bug.
    // If exactly one sonar-secrets hook is registered, add the missing PreToolUse entry.
    if (installedVersion === CLI_105_AFFECTED_VERSION) {
      const hooks = agentConfig.hooks.installed;
      const secretsHooks = hooks.filter((h) => h.name === 'sonar-secrets');
      if (secretsHooks.length === 1 && secretsHooks[0].type === 'UserPromptSubmit') {
        logger.debug('CLI-105 patch: adding missing PreToolUse entry to state');
        addInstalledHook(state, 'claude-code', 'sonar-secrets', 'PreToolUse');
      }
    }

    // Migrate hook scripts on disk: rewrite with new commands
    migrateHookScripts(projectRoot, globalDir);

    // Install new PostToolUse hook
    await installHooks(projectRoot, globalDir, installA3s, projectKey);

    // Register PostToolUse hook in state (legacy format for backward compat)
    addInstalledHook(state, 'claude-code', 'sonar-a3s', 'PostToolUse');

    // Populate agentExtensions registry from old hooks.installed (if not yet migrated)
    migrateToExtensionsRegistry(state, projectRoot, globalDir);

    // Mark migration complete
    state.agents['claude-code'].configuredByCliVersion = CURRENT_VERSION;
    state.agents['claude-code'].migratedAt = new Date().toISOString();

    saveState(state);
    logger.debug('Hook migration completed successfully');
  } catch (err) {
    logger.warn(`Hook migration failed (non-blocking): ${(err as Error).message}`);
  }
}

/**
 * Convert old hooks.installed entries to the new agentExtensions registry.
 * Also registers the sonar-a3s PostToolUse hook if the active connection is cloud.
 * Idempotent: skips if extensions for this agent+project already exist.
 */
function migrateToExtensionsRegistry(
  state: ReturnType<typeof loadState>,
  projectRoot: string,
  globalDir: string | undefined,
): void {
  const isGlobal = globalDir !== undefined;
  const existingExtensions = state.agentExtensions.filter(
    (e) => e.agentId === 'claude-code' && e.projectRoot === projectRoot && e.global === isGlobal,
  );

  const connection = getActiveConnection(state);
  const now = new Date().toISOString();

  const baseExt = {
    agentId: 'claude-code',
    projectRoot,
    global: isGlobal,
    orgKey: connection?.orgKey,
    serverUrl: connection?.serverUrl,
    updatedByCliVersion: CURRENT_VERSION,
    updatedAt: now,
  };

  // Migrate entries from old hooks.installed that don't yet have a registry entry.
  // sonar-a3s is always project-level (never global), regardless of the -g flag.
  const oldHooks = state.agents['claude-code'].hooks.installed;
  for (const hook of oldHooks) {
    const alreadyMigrated = existingExtensions.some(
      (e): e is HookExtension =>
        e.kind === 'hook' && e.name === hook.name && e.hookType === hook.type,
    );
    if (!alreadyMigrated) {
      upsertAgentExtension(state, {
        ...baseExt,
        global: hook.name === 'sonar-a3s' ? false : isGlobal,
        id: randomUUID(),
        kind: 'hook',
        name: hook.name,
        hookType: hook.type,
      });
    }
  }

  // Add the new sonar-a3s PostToolUse extension for cloud connections.
  // A3S is always project-level (never global), regardless of the -g flag.
  const isCloud = connection?.type === 'cloud';
  if (isCloud) {
    upsertAgentExtension(state, {
      ...baseExt,
      global: false,
      id: randomUUID(),
      kind: 'hook',
      name: 'sonar-a3s',
      hookType: 'PostToolUse',
    });
  }
}

/**
 * Rewrite old hook scripts that called `sonar analyze --file` to use specific subcommands.
 * Also called from post-update.ts for automatic migration after CLI upgrades.
 */
export function migrateHookScripts(projectRoot: string, globalDir?: string): void {
  const baseDir = globalDir ?? projectRoot;
  const secretsDir = join(baseDir, '.claude', 'hooks', 'sonar-secrets', 'build-scripts');

  const scripts = [
    'pretool-secrets.sh',
    'prompt-secrets.sh',
    'pretool-secrets.ps1',
    'prompt-secrets.ps1',
  ];

  for (const script of scripts) {
    const scriptPath = join(secretsDir, script);
    if (!existsSync(scriptPath)) {
      continue;
    }

    try {
      const content = readFileSync(scriptPath, 'utf-8');
      // Replace old `sonar analyze --file` with `sonar analyze secrets`
      // Only replace if it's the direct analyze command, not already migrated
      const migrated = content.replaceAll('sonar analyze --file', 'sonar analyze secrets');

      if (migrated !== content) {
        writeFileSync(scriptPath, migrated, 'utf-8');
        logger.debug(`Migrated hook script: ${script}`);
      }
    } catch (err) {
      logger.debug(`Failed to migrate script ${script}: ${(err as Error).message}`);
    }
  }
}
