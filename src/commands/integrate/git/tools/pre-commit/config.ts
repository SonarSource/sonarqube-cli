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

// Helpers for reading and writing .pre-commit-config.yaml and running the pre-commit framework CLI.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as yaml from 'js-yaml';

import { CommandFailedError } from '@/core/command-error.ts';
import type { IntegrationContext } from '@/core/framework/features/types.ts';
import { PRE_COMMIT_CONFIG_FILE } from '@/core/host/git/hooks.ts';
import { spawnProcess } from '@/core/process/process.ts';

import type { GitHookType } from '../../options.ts';
import { resolveDepRisksArgs } from '../shared.ts';

export { PRE_COMMIT_CONFIG_FILE };

// Legacy id shared by both stages before per-stage ids existed. Retained only so existing installs
// are recognized and migrated; never written for new installs.
const PRE_COMMIT_LEGACY_HOOK_ID = 'sonar-secrets';
const PRE_COMMIT_HOOK_IDS: Record<GitHookType, string> = {
  'pre-commit': 'sonar-pre-commit',
  'pre-push': 'sonar-pre-push',
};
export const PRE_COMMIT_LEGACY_REPO = 'https://github.com/SonarSource/sonar-secrets-pre-commit';
const PRE_COMMIT_REMEDIATION_HINT =
  "Install the pre-commit framework (for example 'pip install pre-commit') and ensure 'pre-commit' is on PATH, then retry.";

interface PreCommitHookEntry {
  id: string;
  name: string;
  entry: string;
  language: string;
  pass_filenames?: boolean;
  stages?: string[];
}

interface PreCommitRepo {
  repo: string;
  rev?: string;
  hooks: PreCommitHookEntry[];
}

export interface PreCommitConfig {
  repos: PreCommitRepo[];
  [key: string]: unknown;
}

function buildSonarHook(stage: GitHookType, context: IntegrationContext): PreCommitHookEntry {
  const depRisksArgs =
    stage === 'pre-commit' ? resolveDepRisksArgs(context, { shellQuote: false }) : '';
  return {
    id: PRE_COMMIT_HOOK_IDS[stage],
    name: `Sonar ${stage} scan`,
    entry: `sonar hook git-${stage}${depRisksArgs} --`,
    language: 'system',
    pass_filenames: true,
    stages: [stage],
  };
}

export function normalizePreCommitConfig(raw: unknown): PreCommitConfig {
  if (!raw || typeof raw !== 'object') {
    return { repos: [] };
  }
  const obj = raw as Record<string, unknown>;
  const repos = Array.isArray(obj.repos) ? (obj.repos as PreCommitRepo[]) : [];
  return { ...obj, repos };
}

function isSonarHookEntry(hookEntry: unknown): hookEntry is PreCommitHookEntry {
  if (typeof hookEntry !== 'object' || hookEntry === null || !('id' in hookEntry)) {
    return false;
  }
  const id = (hookEntry as PreCommitHookEntry).id;
  return (
    id === PRE_COMMIT_LEGACY_HOOK_ID ||
    id === PRE_COMMIT_HOOK_IDS['pre-commit'] ||
    id === PRE_COMMIT_HOOK_IDS['pre-push']
  );
}

/** Maps a (possibly legacy/ambiguous) sonar hook entry to its stage; undefined when undeterminable. */
function inferStage(entry: PreCommitHookEntry): GitHookType | undefined {
  if (entry.stages?.includes('pre-push')) {
    return 'pre-push';
  }
  if (entry.stages?.includes('pre-commit') || !entry.stages) {
    return 'pre-commit';
  }
  return undefined;
}

function readPreCommitConfig(root: string): PreCommitConfig {
  try {
    return normalizePreCommitConfig(
      yaml.load(readFileSync(join(root, PRE_COMMIT_CONFIG_FILE), 'utf-8')),
    );
  } catch {
    return { repos: [] };
  }
}

function findLocalRepo(config: PreCommitConfig): PreCommitRepo | undefined {
  return config.repos.find((r) => r.repo === 'local' && Array.isArray(r.hooks));
}

/** Removes the legacy sonar-secrets-pre-commit repo entry. Returns true if anything was removed. */
export function removeLegacyHook(config: PreCommitConfig): boolean {
  const before = config.repos.length;
  config.repos = config.repos.filter((r) => r.repo !== PRE_COMMIT_LEGACY_REPO);
  return config.repos.length < before;
}

/**
 * Remove Sonar-managed hooks from a pre-commit config (inverse of install patch).
 * Drops the legacy remote repo entry and local sonar-secrets hooks; removes an empty local repo.
 */
export function removeSonarHooksFromPreCommitConfig(document: unknown): PreCommitConfig {
  const config = normalizePreCommitConfig(document);
  removeLegacyHook(config);

  for (const repo of config.repos) {
    if (!Array.isArray(repo.hooks)) {
      continue;
    }
    repo.hooks = repo.hooks.filter((hook) => !isSonarHookEntry(hook));
  }

  config.repos = config.repos.filter(
    (repo) => repo.repo !== 'local' || (Array.isArray(repo.hooks) && repo.hooks.length > 0),
  );

  return config;
}

/**
 * Upserts the sonar hook for the given stage into the local repo entry. Targets only this stage:
 * replaces the current per-stage entry, else the same-stage legacy `sonar-secrets` entry (migrating
 * it in place), else appends. A legacy entry for the other stage is left untouched.
 */
export function upsertSonarHook(
  config: PreCommitConfig,
  stage: GitHookType,
  context: IntegrationContext,
): void {
  const hook = buildSonarHook(stage, context);
  const localRepo = findLocalRepo(config);
  if (!localRepo) {
    config.repos.push({ repo: 'local', hooks: [hook] });
    return;
  }
  let idx = localRepo.hooks.findIndex((h) => h.id === PRE_COMMIT_HOOK_IDS[stage]);
  if (idx < 0) {
    idx = localRepo.hooks.findIndex(
      (h) => h.id === PRE_COMMIT_LEGACY_HOOK_ID && inferStage(h) === stage,
    );
  }
  if (idx < 0) {
    idx = localRepo.hooks.length;
  }
  localRepo.hooks[idx] = hook;
}

/** Removes the sonar hook for the given stage (current per-stage id). */
export function removeSonarHook(config: PreCommitConfig, stage: GitHookType): void {
  const localRepo = findLocalRepo(config);
  if (!localRepo) {
    return;
  }
  localRepo.hooks = localRepo.hooks.filter((h) => h.id !== PRE_COMMIT_HOOK_IDS[stage]);
}

/** Removes the legacy sonar-secrets local hook for the given stage. */
export function removeLegacySonarHook(config: PreCommitConfig, stage: GitHookType): void {
  const localRepo = findLocalRepo(config);
  if (!localRepo) {
    return;
  }
  localRepo.hooks = localRepo.hooks.filter(
    (h) => !(h.id === PRE_COMMIT_LEGACY_HOOK_ID && inferStage(h) === stage),
  );
}

/** Return true if .pre-commit-config.yaml already contains the sonar-secrets local hook. */
export function hasSonarHookInPreCommitConfig(root: string): boolean {
  if (!existsSync(join(root, PRE_COMMIT_CONFIG_FILE))) {
    return false;
  }
  return findLocalRepo(readPreCommitConfig(root))?.hooks.some(isSonarHookEntry) ?? false;
}

async function runPreCommitCommand(args: string[], cwd: string): Promise<void> {
  let result;
  try {
    result = await spawnProcess('pre-commit', args, { cwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandFailedError(`Failed to run pre-commit [${message}]`, {
      remediationHint: PRE_COMMIT_REMEDIATION_HINT,
    });
  }
  if (result.exitCode !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n');
    throw new CommandFailedError(
      `pre-commit ${args.join(' ')} failed (exit code ${result.exitCode}) ${detail}`,
      { remediationHint: PRE_COMMIT_REMEDIATION_HINT },
    );
  }
}

/** Run pre-commit uninstall/clean/install to activate the updated config. */
export async function runPreCommitInstall(root: string, hook: GitHookType): Promise<void> {
  await runPreCommitCommand(['uninstall'], root);
  await runPreCommitCommand(['clean'], root);
  await runPreCommitCommand(['install'], root);
  if (hook === 'pre-push') {
    await runPreCommitCommand(['install', '--hook-type', 'pre-push'], root);
  }
}

export async function activatePreCommitFramework(root: string, hook: GitHookType): Promise<void> {
  try {
    await runPreCommitInstall(root, hook);
  } catch {
    const installCommands = `pre-commit uninstall && pre-commit clean && pre-commit install${hook === 'pre-push' ? ' && pre-commit install --hook-type pre-push' : ''}`;
    throw new CommandFailedError(
      `Updated ${PRE_COMMIT_CONFIG_FILE} but pre-commit commands failed.`,
      {
        remediationHint: `Install the pre-commit framework (for example 'pip install pre-commit') and run: ${installCommands}`,
      },
    );
  }
}

/** Best-effort pre-commit gc on Sonar hook removal; never throws. */
export async function garbageCollectPreCommitFramework(root: string): Promise<void> {
  try {
    await runPreCommitCommand(['gc'], root);
  } catch {
    // Missing framework or gc failure — non-fatal for reset.
  }
}
