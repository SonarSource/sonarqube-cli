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

// Auto-migration for Claude Code hooks configuration.
// This migration logic is invoked explicitly from the integrate command.
// It should eventually become part of a dedicated post-update mechanism that
// runs automatically after CLI upgrades, to be implemented in a future iteration.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { version as CURRENT_VERSION } from '../../package.json';
import { installHooks } from '../cli/commands/integrate/claude/hooks';
import logger from './logger';
import type { CliState, HookExtension } from './state';
import {
  addInstalledHook,
  getActiveConnection,
  loadState,
  saveState,
  upsertAgentExtension,
} from './state-manager';

// Version that introduced the new hook architecture (separate secrets/SQAA hooks)
const NEW_HOOK_ARCH_VERSION = CURRENT_VERSION;

// Version known to have the CLI-105 state deduplication bug
const CLI_105_AFFECTED_VERSION = '0.5.1';

export const OBSOLETE_A3S_MARKER = 'sonar-a3s';
const CLAUDE_CONFIG_DIR = '.claude';
const HOOKS_DIR = 'hooks';

interface HookEntry {
  command: string;
  [key: string]: unknown;
}
interface HookConfig {
  hooks: HookEntry[];
  [key: string]: unknown;
}
interface AgentSettings {
  hooks?: Record<string, HookConfig[] | undefined>;
  [key: string]: unknown;
}

async function readObsoleteSettings(settingsPath: string): Promise<AgentSettings | undefined> {
  if (!existsSync(settingsPath)) {
    return undefined;
  }
  try {
    return JSON.parse(await readFile(settingsPath, 'utf-8')) as AgentSettings;
  } catch {
    return undefined;
  }
}

async function removeObsoleteSettingsEntries(installDir: string, marker: string): Promise<void> {
  const settingsPath = join(installDir, CLAUDE_CONFIG_DIR, 'settings.json');
  const settings = await readObsoleteSettings(settingsPath);
  if (!settings?.hooks) {
    return;
  }
  let changed = false;
  for (const eventType of Object.keys(settings.hooks)) {
    const entries = settings.hooks[eventType];
    if (!Array.isArray(entries)) {
      continue;
    }
    const filtered = entries.filter(
      (e) => !(Array.isArray(e.hooks) && e.hooks.some((h) => h.command.includes(marker))),
    );
    if (filtered.length !== entries.length) {
      settings.hooks[eventType] = filtered;
      changed = true;
    }
  }
  if (changed) {
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  }
}

function deleteObsoleteHookDir(installDir: string, marker: string): void {
  const obsoleteDir = join(installDir, CLAUDE_CONFIG_DIR, HOOKS_DIR, marker);
  if (existsSync(obsoleteDir)) {
    rmSync(obsoleteDir, { recursive: true, force: true });
  }
}

/**
 * Remove obsolete hook entries from the settings.json and delete the hook script directory.
 * Does NOT touch state.json — callers are responsible for filtering state in-place.
 */
export async function removeObsoleteHookArtifacts(
  installDir: string,
  marker: string,
): Promise<void> {
  try {
    await removeObsoleteSettingsEntries(installDir, marker);
    deleteObsoleteHookDir(installDir, marker);
  } catch (err) {
    logger.debug(
      `Failed to remove obsolete hook artifacts for ${marker}: ${(err as Error).message}`,
    );
  }
}

/**
 * Remove obsolete hook entries from an in-memory state object.
 * Mutates state in place — caller is responsible for saving.
 */
export function cleanObsoleteFromState(state: CliState, marker: string): void {
  state.agents['claude-code'].hooks.installed = state.agents['claude-code'].hooks.installed.filter(
    (h) => h.name !== marker,
  );
  state.agentExtensions = state.agentExtensions.filter((e) => e.name !== marker);
}

export interface RunMigrationsOptions {
  /**
   * When true, skip migrating/rewriting/installing project-level sonar-secrets hooks.
   * Mirrors the same-named flag on {@link installHooks}; used when a pre-existing
   * global sonar-secrets hook should take precedence over the project-level one.
   */
  skipSecretsHooks?: boolean;
}

/**
 * Run all pending config migrations for Claude Code agent.
 * Called during sonar claude setup. Non-blocking — logs and continues on error.
 */
export async function runMigrations(
  projectRoot: string,
  globalDir?: string,
  installSqaa = false,
  projectKey?: string,
  options: RunMigrationsOptions = {},
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

    const { skipSecretsHooks = false } = options;

    // Migrate hook scripts on disk: rewrite with new commands.
    // When skipSecretsHooks is set, a global hook already exists — leave the
    // project-level scripts alone rather than re-materializing them.
    if (!skipSecretsHooks) {
      migrateHookScripts(projectRoot, globalDir);
    }

    // Install new PostToolUse hook (and refresh secrets hooks unless skipped)
    await installHooks(projectRoot, globalDir, installSqaa, projectKey, { skipSecretsHooks });

    // Clean up obsolete sonar-a3s artifacts (settings.json entries + hook dir on disk)
    await removeObsoleteHookArtifacts(projectRoot, OBSOLETE_A3S_MARKER);

    // Register PostToolUse hook in state (legacy format for backward compat).
    // Only for cloud connections: on-premise servers have no SQAA entitlement.
    if (installSqaa) {
      addInstalledHook(state, 'claude-code', 'sonar-sqaa', 'PostToolUse');
    }

    // Populate agentExtensions registry from old hooks.installed (if not yet migrated)
    migrateToExtensionsRegistry(state, projectRoot, globalDir);

    // Remove obsolete sonar-a3s entries from the in-memory state object before saving.
    // Must happen after migrateToExtensionsRegistry to avoid re-migrating stale entries.
    cleanObsoleteFromState(state, OBSOLETE_A3S_MARKER);

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
 * Also registers the sonar-sqaa PostToolUse hook if the active connection is cloud.
 * Idempotent: skips if extensions for this agent+project already exist.
 */
function migrateToExtensionsRegistry(
  state: ReturnType<typeof loadState>,
  projectRoot: string,
  globalDir: string | undefined,
): void {
  const isGlobal = globalDir !== undefined;
  // For global installs, use globalDir as projectRoot so it doesn't collide with project-level entries.
  const effectiveProjectRoot = globalDir ?? projectRoot;
  const existingExtensions = state.agentExtensions.filter(
    (e) => e.agentId === 'claude-code' && e.projectRoot === effectiveProjectRoot,
  );

  const connection = getActiveConnection(state);
  const now = new Date().toISOString();

  const baseExt = {
    agentId: 'claude-code',
    projectRoot: effectiveProjectRoot,
    global: isGlobal,
    orgKey: connection?.orgKey,
    serverUrl: connection?.serverUrl,
    updatedByCliVersion: CURRENT_VERSION,
    updatedAt: now,
  };

  // Migrate entries from old hooks.installed that don't yet have a registry entry.
  // sonar-sqaa is always project-level (never global), regardless of the -g flag.
  const oldHooks = state.agents['claude-code'].hooks.installed;
  for (const hook of oldHooks) {
    const alreadyMigrated = existingExtensions.some(
      (e): e is HookExtension =>
        e.kind === 'hook' && e.name === hook.name && e.hookType === hook.type,
    );
    if (!alreadyMigrated) {
      const isSqaa = hook.name === 'sonar-sqaa';
      upsertAgentExtension(state, {
        ...baseExt,
        projectRoot: isSqaa ? projectRoot : effectiveProjectRoot,
        global: isSqaa ? false : isGlobal,
        id: randomUUID(),
        kind: 'hook',
        name: hook.name,
        hookType: hook.type,
      });
    }
  }

  // Add the new sonar-sqaa PostToolUse extension for cloud connections.
  // SQAA is always project-level (never global), regardless of the -g flag.
  const isCloud = connection?.type === 'cloud';
  if (isCloud) {
    upsertAgentExtension(state, {
      ...baseExt,
      projectRoot,
      global: false,
      id: randomUUID(),
      kind: 'hook',
      name: 'sonar-sqaa',
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
