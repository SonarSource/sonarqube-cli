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

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { version as CURRENT_VERSION } from '../../package.json';
import { installContextAugmentationBinary } from '../cli/commands/_common/install/context-augmentation';
import { installSecretsBinary } from '../cli/commands/_common/install/secrets';
import {
  type ContextAugmentationAgent,
  installContextAugmentationSkill,
  resolveContextAugmentationAgent,
  stopAllContextAugmentationTools,
} from '../cli/commands/integrate/_common/context-augmentation';
import { installHooks } from '../cli/commands/integrate/claude/hooks.js';
import { CONTEXT_AUGMENTATION_BINARY_NAME, SECRETS_BINARY_NAME } from './install-types.js';
import logger from './logger';
import {
  cleanObsoleteFromState,
  migrateHookScripts,
  OBSOLETE_A3S_MARKER,
  removeObsoleteHookArtifacts,
} from './migration.js';
import { loadState, saveState, stateFileExists } from './repository/state-repository';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from './signatures';
import type { CliState, HookExtension, SkillExtension } from './state.js';
import { recordSkillExtensionInState } from './state-manager';
import { isNewerVersion } from './version';

/**
 * Runs any actions that need to happen once after the CLI has been updated.
 *
 * - Skipped entirely when the state file is absent (fresh installation).
 * - Skipped when the persisted CLI version matches or exceeds the current binary version.
 * - On success the persisted CLI version is bumped to `CURRENT_VERSION` so the
 *   actions are not repeated on the next invocation.
 */
export async function runPostUpdateActions(): Promise<void> {
  if (!stateFileExists()) {
    // No state file means this is a fresh installation — nothing to migrate.
    return;
  }

  const previousVersion = loadState().config.cliVersion;

  if (!isNewerVersion(previousVersion, CURRENT_VERSION)) {
    return;
  }

  logger.debug(`Running post-update actions (${previousVersion} → ${CURRENT_VERSION})`);

  try {
    await runActions(previousVersion, CURRENT_VERSION);
    // Reload state to pick up changes made by subroutines (migrateClaudeCodeHooks,
    // updateSecretsBinaryIfNeeded, updateContextAugmentationIfNeeded) that load
    // and save their own state copies.
    const state = loadState();
    state.config.cliVersion = CURRENT_VERSION;
    cleanObsoleteFromState(state, OBSOLETE_A3S_MARKER);
    saveState(state);
  } catch (error) {
    logger.debug(`Post-update actions failed: ${(error as Error).message}`);
  }
}

async function runActions(_previousVersion: string, _currentVersion: string): Promise<void> {
  await migrateClaudeCodeHooks();
  await updateSecretsBinaryIfNeeded();
  await updateContextAugmentationIfNeeded();
}

/**
 * Update the sonar-secrets binary if it is already installed but targets a different version
 * than the one bundled with this CLI release.
 */
export async function updateSecretsBinaryIfNeeded(): Promise<void> {
  const state = loadState();

  if (!hasPreviousSecretsInstallation(state)) {
    logger.debug('sonar-secrets not installed — skipping binary update');
    return;
  }

  await installSecretsBinary();
}

function hasPreviousSecretsInstallation(state: CliState): boolean {
  return hasBinaryInState(state, SECRETS_BINARY_NAME);
}

function hasBinaryInState(state: CliState, binaryName: string): boolean {
  return (state.tools?.installed ?? []).some((t) => t.name === binaryName);
}

/**
 * Update sonar-context-augmentation and refresh every registered project skill.
 * The skill refresh intentionally does not run `cag init`: post-update has no
 * entitlement/auth context, while the skill template can be regenerated from
 * the recorded project registration.
 */
export async function updateContextAugmentationIfNeeded(): Promise<void> {
  const state = loadState();
  const skills = getContextAugmentationSkills(state);

  if (!shouldUpdateContextAugmentation(state, skills)) {
    logger.debug('sonar-context-augmentation not installed — skipping binary update');
    return;
  }

  await stopExistingContextAugmentationTools(state);

  const binaryPath = await installContextAugmentationBinary();
  await refreshContextAugmentationSkills(binaryPath, skills);
}

function findInstalledToolPath(state: CliState, toolName: string): string | undefined {
  return state.tools?.installed.find((t) => t.name === toolName)?.path;
}

async function stopExistingContextAugmentationTools(state: CliState): Promise<void> {
  const existingPath = findInstalledToolPath(state, CONTEXT_AUGMENTATION_BINARY_NAME);
  if (!existingPath) {
    logger.debug('No previously-installed sonar-context-augmentation — skipping stop');
    return;
  }
  if (!fs.existsSync(existingPath)) {
    logger.debug(`sonar-context-augmentation binary missing at ${existingPath} — skipping stop`);
    return;
  }
  await stopAllContextAugmentationTools(existingPath);
}

function shouldUpdateContextAugmentation(state: CliState, skills: SkillExtension[]): boolean {
  return hasPreviousContextAugmentationInstallation(state) || skills.length > 0;
}

async function refreshContextAugmentationSkills(
  binaryPath: string,
  skills: SkillExtension[],
): Promise<void> {
  if (skills.length === 0) {
    logger.debug('No registered Context Augmentation skills to refresh');
    return;
  }

  for (const skill of uniqueContextAugmentationSkills(skills)) {
    await refreshContextAugmentationSkill(binaryPath, skill);
  }
}

function uniqueContextAugmentationSkills(skills: SkillExtension[]): SkillExtension[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = JSON.stringify([skill.agentId, skill.projectRoot]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function refreshContextAugmentationSkill(
  binaryPath: string,
  skill: SkillExtension,
): Promise<void> {
  if (skill.version === SONAR_CONTEXT_AUGMENTATION_VERSION) {
    logger.debug(
      `Context Augmentation skill already at ${SONAR_CONTEXT_AUGMENTATION_VERSION}: ${skill.projectRoot}`,
    );
    return;
  }

  const agent = getRefreshableContextAugmentationAgent(skill);
  if (!agent) {
    return;
  }

  const refreshed = await tryRefreshContextAugmentationSkill(binaryPath, skill, agent);
  if (!refreshed) {
    return;
  }

  recordRefreshedContextAugmentationSkill(skill);
  logger.debug(`Refreshed Context Augmentation skill for: ${skill.projectRoot}`);
}

function getRefreshableContextAugmentationAgent(
  skill: SkillExtension,
): ContextAugmentationAgent | undefined {
  if (skill.global) {
    logger.debug(`Skipping global Context Augmentation skill: ${skill.agentId}`);
    return undefined;
  }

  const agent = resolveContextAugmentationAgent(skill.agentId);
  if (!agent) {
    logger.debug(`Skipping Context Augmentation skill for unsupported agent: ${skill.agentId}`);
    return undefined;
  }

  if (!isExistingDirectory(skill.projectRoot)) {
    logger.debug(`Skipping Context Augmentation skill for missing project: ${skill.projectRoot}`);
    return undefined;
  }

  return agent;
}

async function tryRefreshContextAugmentationSkill(
  binaryPath: string,
  skill: SkillExtension,
  agent: ContextAugmentationAgent,
): Promise<boolean> {
  try {
    const refreshed = await installContextAugmentationSkill({
      binaryPath,
      agent,
      projectRoot: skill.projectRoot,
      scaEnabled: skill.scaEnabled ?? false,
      reportFailure: false,
    });
    if (!refreshed) {
      logger.debug(
        `Context Augmentation skill refresh failed for ${skill.agentId}: ${skill.projectRoot}`,
      );
    }
    return refreshed;
  } catch (err) {
    logger.debug(
      `Context Augmentation skill refresh failed for ${skill.agentId}: ${(err as Error).message}`,
    );
    return false;
  }
}

function recordRefreshedContextAugmentationSkill(skill: SkillExtension): void {
  recordSkillExtensionInState({
    agentId: skill.agentId,
    projectRoot: skill.projectRoot,
    global: skill.global,
    projectKey: skill.projectKey,
    orgKey: skill.orgKey,
    serverUrl: skill.serverUrl,
    updatedByCliVersion: CURRENT_VERSION,
    name: CONTEXT_AUGMENTATION_BINARY_NAME,
    version: SONAR_CONTEXT_AUGMENTATION_VERSION,
    scaEnabled: skill.scaEnabled ?? false,
  });
}

function hasPreviousContextAugmentationInstallation(state: CliState): boolean {
  return hasBinaryInState(state, CONTEXT_AUGMENTATION_BINARY_NAME);
}

function getContextAugmentationSkills(state: CliState): SkillExtension[] {
  return state.agentExtensions.filter(
    (extension): extension is SkillExtension =>
      extension.kind === 'skill' && extension.name === CONTEXT_AUGMENTATION_BINARY_NAME,
  );
}

function isExistingDirectory(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Migrate Claude Code hook scripts and reinstall secrets hooks for all known locations.
 *
 * Location discovery strategy:
 * 1. If agentExtensions registry has claude-code entries → use those (new format).
 * 2. Fallback for pre-registry installs: if agent is configured but registry is empty,
 *    check whether global hooks exist in homedir()/.claude and migrate there.
 *    Project-level hooks without registry entries cannot be discovered — user must
 *    re-run `sonar integrate claude` once to populate the registry.
 *
 * installSqaa is always false here: SQAA entitlement check requires a token which
 * is not available during post-update. User re-runs `sonar integrate claude` to
 * get the SQAA hook installed.
 *
 * @param homedirFn - Injectable for tests; defaults to os.homedir()
 */
export async function migrateClaudeCodeHooks(homedirFn: () => string = homedir): Promise<void> {
  const state = loadState();

  type Location = { projectRoot: string; globalDir: string | undefined };
  const locations: Location[] = [];

  const extensions = state.agentExtensions.filter(
    (e): e is HookExtension => e.agentId === 'claude-code' && e.kind === 'hook',
  );

  if (extensions.length > 0) {
    // New format: use registry entries, deduplicate by (projectRoot, globalDir)
    const seen = new Set<string>();
    for (const ext of extensions) {
      const globalDir = ext.global ? homedirFn() : undefined;
      const key = `${ext.projectRoot}|${globalDir ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push({ projectRoot: ext.projectRoot, globalDir });
    }
  } else if (state.agents['claude-code'].configured) {
    // Pre-registry fallback: check for global hooks in homedir
    const globalHooksDir = join(homedirFn(), '.claude', 'hooks', 'sonar-secrets');
    if (fs.existsSync(globalHooksDir)) {
      locations.push({ projectRoot: homedirFn(), globalDir: homedirFn() });
    }
  }

  for (const { projectRoot, globalDir } of locations) {
    try {
      migrateHookScripts(projectRoot, globalDir);
      await installHooks(projectRoot, globalDir, false);
      await removeObsoleteHookArtifacts(projectRoot, OBSOLETE_A3S_MARKER);
      logger.debug(`Migrated Claude Code hooks for: ${globalDir ?? projectRoot}`);
    } catch (err) {
      logger.debug(
        `Hook migration failed for ${globalDir ?? projectRoot}: ${(err as Error).message}`,
      );
    }
  }
}
