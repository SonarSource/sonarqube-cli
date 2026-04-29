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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import yaml from 'js-yaml';

import { spawnProcess } from '../../../../lib/process';
import { success, text } from '../../../../ui';
import { CommandFailedError } from '../../_common/error';
import type { GitHookType } from '.';

export const PRE_COMMIT_CONFIG_FILE = '.pre-commit-config.yaml';
const PRE_COMMIT_SONAR_HOOK_ID = 'sonar-secrets';
export const PRE_COMMIT_LEGACY_REPO = 'https://github.com/SonarSource/sonar-secrets-pre-commit';

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

function buildSonarPreCommitHook(stage: GitHookType): PreCommitHookEntry {
  return {
    id: PRE_COMMIT_SONAR_HOOK_ID,
    name: 'Sonar secrets scan',
    entry: 'sonar analyze secrets --',
    language: 'system',
    pass_filenames: true,
    stages: [stage],
  };
}

function parsePreCommitConfig(raw: unknown): PreCommitConfig {
  if (!raw || typeof raw !== 'object') {
    return { repos: [] };
  }
  const obj = raw as Record<string, unknown>;
  const repos = Array.isArray(obj.repos) ? (obj.repos as PreCommitRepo[]) : [];
  return { ...obj, repos };
}

function isSonarHookEntry(hookEntry: unknown): hookEntry is PreCommitHookEntry {
  return (
    typeof hookEntry === 'object' &&
    hookEntry !== null &&
    'id' in hookEntry &&
    (hookEntry as PreCommitHookEntry).id === PRE_COMMIT_SONAR_HOOK_ID
  );
}

function readPreCommitConfig(root: string): PreCommitConfig {
  try {
    return parsePreCommitConfig(
      yaml.load(readFileSync(join(root, PRE_COMMIT_CONFIG_FILE), 'utf-8')),
    );
  } catch {
    return { repos: [] };
  }
}

function writePreCommitConfig(root: string, config: PreCommitConfig): void {
  writeFileSync(join(root, PRE_COMMIT_CONFIG_FILE), yaml.dump(config, { lineWidth: -1 }), 'utf-8');
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

/** Upserts the sonar-secrets hook into the local repo entry of a config object. */
export function upsertSonarHook(config: PreCommitConfig, stage: GitHookType): void {
  const sonarHook = buildSonarPreCommitHook(stage);
  const localRepo = findLocalRepo(config);
  if (localRepo) {
    const index = localRepo.hooks.findIndex(isSonarHookEntry);
    const idx = index >= 0 ? index : localRepo.hooks.length;
    localRepo.hooks[idx] = sonarHook;
  } else {
    config.repos.push({ repo: 'local', hooks: [sonarHook] });
  }
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
    throw new CommandFailedError(`Failed to run pre-commit [${message}]`);
  }
  if (result.exitCode !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n');
    throw new CommandFailedError(
      `pre-commit ${args.join(' ')} failed (exit code ${result.exitCode}) ${detail}`,
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

export async function installViaPreCommitFramework(root: string, hook: GitHookType): Promise<void> {
  const config = readPreCommitConfig(root);
  const isLegacyHookRemoved = removeLegacyHook(config);
  upsertSonarHook(config, hook);
  writePreCommitConfig(root, config);
  if (isLegacyHookRemoved) {
    text(`Removed legacy ${PRE_COMMIT_LEGACY_REPO} hook from ${PRE_COMMIT_CONFIG_FILE}.`);
  }
  try {
    await runPreCommitInstall(root, hook);
  } catch {
    const errorMessage = `Updated ${PRE_COMMIT_CONFIG_FILE} but pre-commit commands failed. Install the pre-commit framework (e.g. pip install pre-commit) and run: pre-commit uninstall && pre-commit clean && pre-commit install${hook === 'pre-push' ? ' && pre-commit install --hook-type pre-push' : ''}`;
    throw new CommandFailedError(errorMessage);
  }
  success(`${hook} hook installed (pre-commit framework: added to ${PRE_COMMIT_CONFIG_FILE}).`);
}
