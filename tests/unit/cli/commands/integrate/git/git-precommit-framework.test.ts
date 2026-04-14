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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import yaml from 'js-yaml';
import { CommandFailedError } from '../../../../../../src/cli/commands/_common/error';
import {
  PRE_COMMIT_CONFIG_FILE,
  hasSonarHookInPreCommitConfig,
  upsertPreCommitConfig,
  runPreCommitInstall,
  installViaPreCommitFramework,
} from '../../../../../../src/cli/commands/integrate/git/git-precommit-framework';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../../../../../src/ui/mock';
import * as processLib from '../../../../../../src/lib/process.js';

const TEMP_DIR = join(process.cwd(), 'tests', 'unit', '.git-precommit-framework-tmp');

const PRE_COMMIT_OK = { exitCode: 0, stdout: '', stderr: '' };
const PRE_COMMIT_FAIL = { exitCode: 1, stdout: '', stderr: 'something went wrong' };

function readConfig(): Record<string, unknown> {
  return yaml.load(readFileSync(join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE), 'utf-8')) as Record<
    string,
    unknown
  >;
}

describe('hasSonarHookInPreCommitConfig', () => {
  beforeEach(() => mkdirSync(TEMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TEMP_DIR, { recursive: true, force: true }));

  it('returns false when the config file does not exist', () => {
    expect(hasSonarHookInPreCommitConfig(TEMP_DIR)).toBe(false);
  });

  it('returns true when the config contains a sonar-secrets hook in a local repo', () => {
    writeFileSync(
      join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE),
      yaml.dump({
        repos: [
          {
            repo: 'local',
            hooks: [{ id: 'sonar-secrets', name: 'x', entry: 'e', language: 'system' }],
          },
        ],
      }),
    );
    expect(hasSonarHookInPreCommitConfig(TEMP_DIR)).toBe(true);
  });

  it('returns false when the config contains only other hooks in a local repo', () => {
    writeFileSync(
      join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE),
      yaml.dump({
        repos: [
          {
            repo: 'local',
            hooks: [{ id: 'other-hook', name: 'x', entry: 'e', language: 'system' }],
          },
        ],
      }),
    );
    expect(hasSonarHookInPreCommitConfig(TEMP_DIR)).toBe(false);
  });

  it('returns false when the config has no repos', () => {
    writeFileSync(join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE), yaml.dump({ repos: [] }));
    expect(hasSonarHookInPreCommitConfig(TEMP_DIR)).toBe(false);
  });

  it('returns false when the local repo has an empty hooks array', () => {
    writeFileSync(
      join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE),
      yaml.dump({ repos: [{ repo: 'local', hooks: [] }] }),
    );
    expect(hasSonarHookInPreCommitConfig(TEMP_DIR)).toBe(false);
  });

  it('returns false when sonar-secrets is in a non-local repo', () => {
    writeFileSync(
      join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE),
      yaml.dump({
        repos: [{ repo: 'https://github.com/example/hooks', hooks: [{ id: 'sonar-secrets' }] }],
      }),
    );
    expect(hasSonarHookInPreCommitConfig(TEMP_DIR)).toBe(false);
  });
});

describe('upsertPreCommitConfig — parsing', () => {
  beforeEach(() => mkdirSync(TEMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TEMP_DIR, { recursive: true, force: true }));

  it('creates a new config file with a local repo and the sonar-secrets hook', () => {
    upsertPreCommitConfig(TEMP_DIR, 'pre-commit');

    const config = readConfig();
    expect(Array.isArray(config.repos)).toBe(true);
    const repos = config.repos as Array<{ repo: string; hooks: Array<{ id: string }> }>;
    const localRepo = repos.find((r) => r.repo === 'local');
    expect(localRepo).toBeDefined();
    expect(localRepo?.hooks.some((h) => h.id === 'sonar-secrets')).toBe(true);
  });

  it('sets the stage to pre-commit when called with pre-commit', () => {
    upsertPreCommitConfig(TEMP_DIR, 'pre-commit');

    const config = readConfig();
    const repos = config.repos as Array<{
      repo: string;
      hooks: Array<{ id: string; stages: string[] }>;
    }>;
    const hook = repos.find((r) => r.repo === 'local')?.hooks.find((h) => h.id === 'sonar-secrets');
    expect(hook?.stages).toEqual(['pre-commit']);
  });

  it('sets the stage to pre-push when called with pre-push', () => {
    upsertPreCommitConfig(TEMP_DIR, 'pre-push');

    const config = readConfig();
    const repos = config.repos as Array<{
      repo: string;
      hooks: Array<{ id: string; stages: string[] }>;
    }>;
    const hook = repos.find((r) => r.repo === 'local')?.hooks.find((h) => h.id === 'sonar-secrets');
    expect(hook?.stages).toEqual(['pre-push']);
  });

  it('appends a local repo with the hook to a config that already has unrelated repos', () => {
    writeFileSync(
      join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE),
      yaml.dump({
        repos: [
          {
            repo: 'https://github.com/pre-commit/pre-commit-hooks',
            rev: 'v4.5.0',
            hooks: [{ id: 'trailing-whitespace' }],
          },
        ],
      }),
    );

    upsertPreCommitConfig(TEMP_DIR, 'pre-commit');

    const config = readConfig();
    const repos = config.repos as Array<{ repo: string; hooks: Array<{ id: string }> }>;
    expect(repos).toHaveLength(2);
    expect(repos.some((r) => r.repo === 'https://github.com/pre-commit/pre-commit-hooks')).toBe(
      true,
    );
    const localRepo = repos.find((r) => r.repo === 'local');
    expect(localRepo).toBeDefined();
    expect(localRepo?.hooks).toHaveLength(1);
    expect(localRepo?.hooks.some((h) => h.id === 'sonar-secrets')).toBe(true);
  });

  it('adds the hook to an existing local repo that has no sonar-secrets hook yet', () => {
    writeFileSync(
      join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE),
      yaml.dump({
        repos: [
          {
            repo: 'local',
            hooks: [{ id: 'other-hook', name: 'x', entry: 'e', language: 'system' }],
          },
        ],
      }),
    );

    upsertPreCommitConfig(TEMP_DIR, 'pre-commit');

    const config = readConfig();
    const repos = config.repos as Array<{ repo: string; hooks: Array<{ id: string }> }>;
    const localRepo = repos.find((r) => r.repo === 'local');
    expect(localRepo?.hooks).toHaveLength(2);
    expect(localRepo?.hooks.some((h) => h.id === 'sonar-secrets')).toBe(true);
    expect(localRepo?.hooks.some((h) => h.id === 'other-hook')).toBe(true);
  });

  it('replaces the existing sonar-secrets hook in place without duplicating it', () => {
    writeFileSync(
      join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE),
      yaml.dump({
        repos: [
          {
            repo: 'local',
            hooks: [
              {
                id: 'sonar-secrets',
                name: 'old name',
                entry: 'old entry',
                language: 'system',
                stages: ['pre-push'],
              },
            ],
          },
        ],
      }),
    );

    upsertPreCommitConfig(TEMP_DIR, 'pre-commit');

    const config = readConfig();
    const repos = config.repos as Array<{
      repo: string;
      hooks: Array<{ id: string; stages: string[] }>;
    }>;
    const localRepo = repos.find((r) => r.repo === 'local');
    const sonarHooks = localRepo?.hooks.filter((h) => h.id === 'sonar-secrets');
    expect(sonarHooks).toHaveLength(1);
    expect(sonarHooks?.[0].stages).toEqual(['pre-commit']);
  });

  it('falls back to an empty repos list when the file contains invalid YAML', () => {
    writeFileSync(join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE), '{ invalid yaml :::');

    upsertPreCommitConfig(TEMP_DIR, 'pre-commit');

    const config = readConfig();
    const repos = config.repos as Array<{ repo: string }>;
    expect(repos.some((r) => r.repo === 'local')).toBe(true);
  });

  it('falls back to an empty repos list when the file is empty', () => {
    writeFileSync(join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE), '');

    upsertPreCommitConfig(TEMP_DIR, 'pre-commit');

    const config = readConfig();
    const repos = config.repos as Array<{ repo: string }>;
    expect(repos.some((r) => r.repo === 'local')).toBe(true);
  });

  it('treats a repos value that is not an array as an empty list', () => {
    writeFileSync(join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE), yaml.dump({ repos: 'not-an-array' }));

    upsertPreCommitConfig(TEMP_DIR, 'pre-commit');

    const config = readConfig();
    const repos = config.repos as Array<{ repo: string; hooks: Array<{ id: string }> }>;
    const localRepo = repos.find((r) => r.repo === 'local');
    expect(localRepo).toBeDefined();
    expect(localRepo?.hooks).toHaveLength(1);
    expect(localRepo?.hooks.some((h) => h.id === 'sonar-secrets')).toBe(true);
  });

  it('preserves top-level keys that are not repos', () => {
    writeFileSync(
      join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE),
      yaml.dump({ default_install_hook_types: ['pre-commit'], repos: [] }),
    );

    upsertPreCommitConfig(TEMP_DIR, 'pre-commit');

    const config = readConfig();
    expect(config.default_install_hook_types).toEqual(['pre-commit']);
  });
});

describe('runPreCommitInstall', () => {
  it('calls pre-commit uninstall, clean, and install for pre-commit stage', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(PRE_COMMIT_OK);

    try {
      await runPreCommitInstall(TEMP_DIR, 'pre-commit');

      const calls = spawnSpy.mock.calls.map((c) => (c as [string, string[]])[1]);
      expect(calls).toContainEqual(['uninstall']);
      expect(calls).toContainEqual(['clean']);
      expect(calls).toContainEqual(['install']);
      expect(calls).not.toContainEqual(['install', '--hook-type', 'pre-push']);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('also calls pre-commit install --hook-type pre-push for pre-push stage', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(PRE_COMMIT_OK);

    try {
      await runPreCommitInstall(TEMP_DIR, 'pre-push');

      const calls = spawnSpy.mock.calls.map((c) => (c as [string, string[]])[1]);
      expect(calls).toContainEqual(['install', '--hook-type', 'pre-push']);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('throws when a pre-commit command exits with non-zero code', () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(PRE_COMMIT_FAIL);

    try {
      expect(runPreCommitInstall(TEMP_DIR, 'pre-commit')).rejects.toThrow(
        'pre-commit uninstall failed',
      );
    } finally {
      spawnSpy.mockRestore();
    }
  });
});

describe('installViaPreCommitFramework', () => {
  beforeEach(() => {
    mkdirSync(TEMP_DIR, { recursive: true });
    setMockUi(true);
    clearMockUiCalls();
  });

  afterEach(() => {
    setMockUi(false);
    rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  it('writes the config file and shows a success message when pre-commit commands succeed', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(PRE_COMMIT_OK);

    try {
      await installViaPreCommitFramework(TEMP_DIR, 'pre-commit');

      expect(hasSonarHookInPreCommitConfig(TEMP_DIR)).toBe(true);
      expect(getMockUiCalls().some((c) => c.method === 'success')).toBe(true);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('throws CommandFailedError when pre-commit commands fail', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(PRE_COMMIT_FAIL);

    try {
      let caughtError: unknown;
      try {
        await installViaPreCommitFramework(TEMP_DIR, 'pre-commit');
      } catch (e) {
        caughtError = e;
      }
      expect(caughtError).toBeDefined();
      expect(caughtError).toBeInstanceOf(CommandFailedError);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('still writes the config file even when pre-commit commands fail', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(PRE_COMMIT_FAIL);

    try {
      await installViaPreCommitFramework(TEMP_DIR, 'pre-commit').catch(() => {});
      expect(hasSonarHookInPreCommitConfig(TEMP_DIR)).toBe(true);
    } finally {
      spawnSpy.mockRestore();
    }
  });
});
