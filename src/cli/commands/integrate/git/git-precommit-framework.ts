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

// Helpers for reading and writing .pre-commit-config.yaml and running the pre-commit framework CLI.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { spawnProcess } from '../../../../lib/process';
import { CommandFailedError } from '../../_common/error';
import { success } from '../../../../ui';
import type { GitHookType } from '.';

export const PRE_COMMIT_CONFIG_FILE = '.pre-commit-config.yaml';
const PRE_COMMIT_SONAR_HOOK_ID = 'sonar-secrets';

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

interface PreCommitConfig {
  repos: PreCommitRepo[];
  [key: string]: unknown;
}

function buildSonarPreCommitHook(stage: GitHookType): PreCommitHookEntry {
  const base: PreCommitHookEntry = {
    id: PRE_COMMIT_SONAR_HOOK_ID,
    name: 'Sonar secrets scan',
    entry: 'sonar analyze secrets --',
    language: 'system',
    pass_filenames: true,
    stages: [stage],
  };
  return base;
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

function findExistingSonarHook(configPath: string): {
  config: PreCommitConfig;
  repo: { hooks: unknown[] } | undefined;
  index: number;
} {
  let config: PreCommitConfig;
  try {
    config = parsePreCommitConfig(yaml.load(readFileSync(configPath, 'utf-8')));
  } catch {
    config = { repos: [] };
  }
  const repo = config.repos.find((r) => r.repo === 'local' && Array.isArray(r.hooks)) as
    | { hooks: unknown[] }
    | undefined;
  return { config, repo, index: repo ? repo.hooks.findIndex(isSonarHookEntry) : -1 };
}

/** Upsert the sonar-secrets hook into .pre-commit-config.yaml. */
export function upsertPreCommitConfig(root: string, stage: GitHookType): void {
  const configPath = join(root, PRE_COMMIT_CONFIG_FILE);
  const sonarHook = buildSonarPreCommitHook(stage);
  const { config, repo, index } = findExistingSonarHook(configPath);
  if (repo) {
    const idx = index >= 0 ? index : repo.hooks.length;
    repo.hooks[idx] = sonarHook;
  } else {
    config.repos.push({ repo: 'local', hooks: [sonarHook] });
  }
  writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }), 'utf-8');
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

/** Return true if .pre-commit-config.yaml already contains the sonar-secrets local hook. */
export function hasSonarHookInPreCommitConfig(root: string): boolean {
  const configPath = join(root, PRE_COMMIT_CONFIG_FILE);
  if (!existsSync(configPath)) return false;
  const { repo, index } = findExistingSonarHook(configPath);
  return repo !== undefined && index >= 0;
}

export async function installViaPreCommitFramework(root: string, hook: GitHookType): Promise<void> {
  upsertPreCommitConfig(root, hook);
  try {
    await runPreCommitInstall(root, hook);
  } catch {
    const errorMessage = `Updated ${PRE_COMMIT_CONFIG_FILE} but pre-commit commands failed. Install the pre-commit framework (e.g. pip install pre-commit) and run: pre-commit uninstall && pre-commit clean && pre-commit install${hook === 'pre-push' ? ' && pre-commit install --hook-type pre-push' : ''}`;
    throw new CommandFailedError(errorMessage);
  }
  success(`${hook} hook installed (pre-commit framework: added to ${PRE_COMMIT_CONFIG_FILE}).`);
}
