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

function buildSonarPreCommitHook(hook: GitHookType): PreCommitHookEntry {
  const base: PreCommitHookEntry = {
    id: PRE_COMMIT_SONAR_HOOK_ID,
    name: 'Sonar secrets scan',
    entry: 'sonar analyze secrets',
    language: 'system',
    pass_filenames: true,
  };
  if (hook === 'pre-push') {
    base.stages = ['push'];
  }
  return base;
}

function parsePreCommitConfig(raw: unknown): PreCommitConfig {
  if (!raw || typeof raw !== 'object' || !('repos' in raw)) {
    return { repos: [] };
  }
  const repos = (raw as { repos: unknown }).repos;
  const list = Array.isArray(repos) ? (repos as PreCommitRepo[]) : [];
  return { repos: list };
}

function isLocalHookEntry(h: unknown): h is PreCommitHookEntry {
  return (
    typeof h === 'object' &&
    h !== null &&
    'id' in h &&
    (h as PreCommitHookEntry).id === PRE_COMMIT_SONAR_HOOK_ID
  );
}

/** Upsert the sonar-secrets hook into .pre-commit-config.yaml. */
export function ensurePreCommitConfig(root: string, hook: GitHookType): void {
  const configPath = join(root, PRE_COMMIT_CONFIG_FILE);
  let config: PreCommitConfig;
  try {
    config = parsePreCommitConfig(yaml.load(readFileSync(configPath, 'utf-8')));
  } catch {
    config = { repos: [] };
  }

  const sonarHook = buildSonarPreCommitHook(hook);
  let found = false;
  for (const repo of config.repos) {
    const r = repo as { repo?: string; hooks?: unknown[] };
    if (r.repo !== 'local' || !Array.isArray(r.hooks)) continue;
    const idx = r.hooks.findIndex(isLocalHookEntry);
    if (idx >= 0) {
      r.hooks[idx] = sonarHook;
      found = true;
      break;
    }
  }
  if (!found) {
    config.repos.push({ repo: 'local', hooks: [sonarHook] });
  }

  writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }), 'utf-8');
}

async function runPreCommitCommand(args: string[], cwd: string): Promise<void> {
  const result = await spawnProcess('pre-commit', args, { cwd });
  if (result.exitCode !== 0) {
    const detailSuffix = detail ? `: ${detail}` : '';
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n');
    throw new Error(
      `pre-commit ${args.join(' ')} failed (exit code ${result.exitCode})${detailSuffix}`,
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
  try {
    const config = parsePreCommitConfig(yaml.load(readFileSync(configPath, 'utf-8')));
    for (const repo of config.repos) {
      const r = repo as { repo?: string; hooks?: unknown[] };
      if (r.repo !== 'local' || !Array.isArray(r.hooks)) continue;
      if (r.hooks.some(isLocalHookEntry)) return true;
    }
  } catch {
    // ignore
  }
  return false;
}
