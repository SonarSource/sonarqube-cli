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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import yaml from 'js-yaml';

import { CommandFailedError } from '../../../../../../src/cli/commands/_common/error';
import type { IntegrationContext } from '../../../../../../src/cli/commands/integrate/_common/registry';
import { IntegrationInstaller } from '../../../../../../src/cli/commands/integrate/_common/registry';
import {
  activatePreCommitFramework,
  hasSonarHookInPreCommitConfig,
  normalizePreCommitConfig,
  PRE_COMMIT_CONFIG_FILE,
  PRE_COMMIT_LEGACY_REPO,
  type PreCommitConfig,
  preCommitIntegration,
  removeLegacyHook,
  runPreCommitInstall,
  upsertSonarHook,
} from '../../../../../../src/cli/commands/integrate/git/tools/pre-commit';
import * as processLib from '../../../../../../src/lib/process.js';
import { getDefaultState } from '../../../../../../src/lib/state';

const TEMP_DIR = join(process.cwd(), 'tests', 'unit', '.git-precommit-framework-tmp');

const PRE_COMMIT_OK = { exitCode: 0, stdout: '', stderr: '' };
const PRE_COMMIT_FAIL = { exitCode: 1, stdout: '', stderr: 'something went wrong' };

describe('normalizePreCommitConfig', () => {
  it('returns the default shape for non-object values', () => {
    expect(normalizePreCommitConfig(undefined)).toEqual({ repos: [] });
  });

  it('preserves unrelated keys and normalizes invalid repos values', () => {
    expect(
      normalizePreCommitConfig({
        default_install_hook_types: ['pre-commit'],
        repos: 'not-an-array',
      }),
    ).toEqual({
      default_install_hook_types: ['pre-commit'],
      repos: [],
    });
  });
});

describe('removeLegacyHook', () => {
  it('removes the legacy repo entry and returns true', () => {
    const config: PreCommitConfig = {
      repos: [
        {
          repo: PRE_COMMIT_LEGACY_REPO,
          hooks: [{ id: 'sonar-secrets', name: 'x', entry: 'e', language: 'system' }],
        },
      ],
    };
    expect(removeLegacyHook(config)).toBe(true);
    expect(config.repos).toHaveLength(0);
  });

  it('returns false when no legacy repo is present', () => {
    const config: PreCommitConfig = { repos: [] };
    expect(removeLegacyHook(config)).toBe(false);
  });

  it('preserves unrelated repos', () => {
    const config: PreCommitConfig = {
      repos: [
        { repo: PRE_COMMIT_LEGACY_REPO, hooks: [] },
        { repo: 'https://github.com/pre-commit/pre-commit-hooks', hooks: [] },
      ],
    };
    removeLegacyHook(config);
    expect(config.repos).toHaveLength(1);
    expect(config.repos[0].repo).toBe('https://github.com/pre-commit/pre-commit-hooks');
  });
});

describe('upsertSonarHook', () => {
  it('writes the correct hook shape for pre-commit stage', () => {
    const config: PreCommitConfig = { repos: [] };
    upsertSonarHook(config, 'pre-commit');
    const hook = config.repos.find((r) => r.repo === 'local')?.hooks[0];
    expect(hook).toEqual({
      id: 'sonar-secrets',
      name: 'Sonar pre-commit scan',
      entry: 'sonar hook git-pre-commit',
      language: 'system',
      pass_filenames: true,
      stages: ['pre-commit'],
    });
  });

  it('writes the correct hook shape for pre-push stage', () => {
    const config: PreCommitConfig = { repos: [] };
    upsertSonarHook(config, 'pre-push');
    const hook = config.repos.find((r) => r.repo === 'local')?.hooks[0];
    expect(hook).toEqual({
      id: 'sonar-secrets',
      name: 'Sonar pre-push scan',
      entry: 'sonar hook git-pre-push',
      language: 'system',
      pass_filenames: true,
      stages: ['pre-push'],
    });
  });

  it('creates a local repo with the sonar-secrets hook when no repos exist', () => {
    const config: PreCommitConfig = { repos: [] };
    upsertSonarHook(config, 'pre-commit');
    const localRepo = config.repos.find((r) => r.repo === 'local');
    expect(localRepo?.hooks.some((h) => h.id === 'sonar-secrets')).toBe(true);
  });

  it('appends a local repo when only unrelated repos exist', () => {
    const config: PreCommitConfig = {
      repos: [{ repo: 'https://github.com/pre-commit/pre-commit-hooks', hooks: [] }],
    };
    upsertSonarHook(config, 'pre-commit');
    expect(config.repos).toHaveLength(2);
    expect(
      config.repos.find((r) => r.repo === 'local')?.hooks.some((h) => h.id === 'sonar-secrets'),
    ).toBe(true);
  });

  it('adds the hook to an existing local repo that has no sonar-secrets hook yet', () => {
    const config: PreCommitConfig = {
      repos: [
        { repo: 'local', hooks: [{ id: 'other-hook', name: 'x', entry: 'e', language: 'system' }] },
      ],
    };
    upsertSonarHook(config, 'pre-commit');
    const localRepo = config.repos.find((r) => r.repo === 'local');
    expect(localRepo?.hooks).toHaveLength(2);
    expect(localRepo?.hooks.some((h) => h.id === 'sonar-secrets')).toBe(true);
    expect(localRepo?.hooks.some((h) => h.id === 'other-hook')).toBe(true);
  });

  it('replaces the existing sonar-secrets hook in place without duplicating it', () => {
    const config: PreCommitConfig = {
      repos: [
        {
          repo: 'local',
          hooks: [
            {
              id: 'sonar-secrets',
              name: 'old',
              entry: 'old',
              language: 'system',
              stages: ['pre-push'],
            },
          ],
        },
      ],
    };
    upsertSonarHook(config, 'pre-commit');
    const localRepo = config.repos.find((r) => r.repo === 'local');
    const sonarHooks = localRepo?.hooks.filter((h) => h.id === 'sonar-secrets');
    expect(sonarHooks).toHaveLength(1);
    expect(sonarHooks?.[0].stages).toEqual(['pre-commit']);
  });

  it('replaces the existing sonar-secrets hook in place for pre-push stage', () => {
    const config: PreCommitConfig = {
      repos: [
        {
          repo: 'local',
          hooks: [
            {
              id: 'sonar-secrets',
              name: 'old',
              entry: 'old-entry',
              language: 'system',
              stages: ['pre-commit'],
            },
          ],
        },
      ],
    };
    upsertSonarHook(config, 'pre-push');
    const localRepo = config.repos.find((r) => r.repo === 'local');
    const hooks = localRepo?.hooks.filter((h) => h.id === 'sonar-secrets');
    expect(hooks).toHaveLength(1);
    expect(hooks?.[0].entry).toBe('sonar hook git-pre-push');
  });

  it('preserves top-level keys that are not repos', () => {
    const config: PreCommitConfig = { default_install_hook_types: ['pre-commit'], repos: [] };
    upsertSonarHook(config, 'pre-commit');
    expect(config.default_install_hook_types).toEqual(['pre-commit']);
  });
});

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

  it('throws CommandFailedError when spawnProcess rejects', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockRejectedValue(new Error('not found'));

    try {
      const err = await runPreCommitInstall(TEMP_DIR, 'pre-commit').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommandFailedError);
      expect((err as CommandFailedError).message).toContain('Failed to run pre-commit [not found]');
    } finally {
      spawnSpy.mockRestore();
    }
  });
});

describe('activatePreCommitFramework', () => {
  it('succeeds when all pre-commit commands pass', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(PRE_COMMIT_OK);

    try {
      await activatePreCommitFramework(TEMP_DIR, 'pre-commit');
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('throws CommandFailedError with remediation hint when commands fail (pre-commit stage)', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(PRE_COMMIT_FAIL);

    try {
      const err: unknown = await activatePreCommitFramework(TEMP_DIR, 'pre-commit').catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CommandFailedError);
      expect((err as CommandFailedError).message).toContain(
        'Updated .pre-commit-config.yaml but pre-commit commands failed.',
      );
      expect((err as CommandFailedError).remediationHint).toContain('pre-commit install');
      expect((err as CommandFailedError).remediationHint).not.toContain('--hook-type pre-push');
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('includes --hook-type pre-push in remediation hint for pre-push stage', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(PRE_COMMIT_FAIL);

    try {
      const err: unknown = await activatePreCommitFramework(TEMP_DIR, 'pre-push').catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CommandFailedError);
      expect((err as CommandFailedError).remediationHint).toContain('--hook-type pre-push');
    } finally {
      spawnSpy.mockRestore();
    }
  });
});

describe('pre-commit integration remove', () => {
  const installer = new IntegrationInstaller();
  const preCommitFeature = preCommitIntegration.features.find((f) => f.id === 'pre-commit-hook');
  if (!preCommitFeature) {
    throw new Error('pre-commit-hook feature not found');
  }

  beforeEach(() => mkdirSync(TEMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TEMP_DIR, { recursive: true, force: true }));

  it('removes only Sonar hooks from the config without invoking the pre-commit framework CLI', async () => {
    writeFileSync(
      join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE),
      yaml.dump({
        repos: [
          {
            repo: PRE_COMMIT_LEGACY_REPO,
            rev: 'v2.41.0.10709',
            hooks: [{ id: 'sonar-secrets', stages: ['pre-commit'] }],
          },
          {
            repo: 'https://github.com/pre-commit/pre-commit-hooks',
            rev: 'v4.6.0',
            hooks: [{ id: 'trailing-whitespace' }],
          },
          {
            repo: 'local',
            hooks: [
              { id: 'other-local-hook', name: 'x', entry: 'echo', language: 'system' },
              {
                id: 'sonar-secrets',
                name: 'Sonar pre-commit scan',
                entry: 'sonar hook git-pre-commit',
                language: 'system',
                stages: ['pre-commit'],
              },
            ],
          },
        ],
      }),
    );

    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(PRE_COMMIT_OK);
    const context: IntegrationContext = {
      state: getDefaultState('test'),
      targetRoot: TEMP_DIR,
      scope: 'project',
      executionMode: 'install',
      resolvedDependencies: new Map(),
    };

    try {
      await installer.removeFeature(context, preCommitFeature);
      expect(spawnSpy).not.toHaveBeenCalled();

      const config = yaml.load(
        readFileSync(join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE), 'utf-8'),
      ) as PreCommitConfig;
      expect(config.repos.some((r) => r.repo === PRE_COMMIT_LEGACY_REPO)).toBe(false);
      const thirdPartyRepo = config.repos.find(
        (r) => r.repo === 'https://github.com/pre-commit/pre-commit-hooks',
      );
      expect(thirdPartyRepo?.hooks.map((hook) => hook.id)).toEqual(['trailing-whitespace']);
      const localRepo = config.repos.find((r) => r.repo === 'local');
      expect(localRepo?.hooks.map((hook) => hook.id)).toEqual(['other-local-hook']);
      expect(hasSonarHookInPreCommitConfig(TEMP_DIR)).toBe(false);
    } finally {
      spawnSpy.mockRestore();
    }
  });
});
