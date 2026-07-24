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
import * as yaml from 'js-yaml';

import { CommandFailedError } from '@/core/command-error.ts';
import * as processLib from '@/core/process/process.ts';
import { getDefaultState } from '@/core/state/state.ts';

import type { ContainerIntegrationContext } from '../../../../../src/commands/integrate/_common/registry';
import { IntegrationInstaller } from '../../../../../src/commands/integrate/_common/registry';
import {
  activatePreCommitFramework,
  garbageCollectPreCommitFramework,
  hasSonarHookInPreCommitConfig,
  normalizePreCommitConfig,
  PRE_COMMIT_CONFIG_FILE,
  PRE_COMMIT_LEGACY_REPO,
  type PreCommitConfig,
  preCommitIntegration,
  removeLegacyHook,
  removeLegacySonarHook,
  removeSonarHook,
  runPreCommitInstall,
  upsertSonarHook,
} from '../../../../../src/commands/integrate/git/tools/pre-commit';

const TEMP_DIR = join(process.cwd(), 'tests', 'unit', '.git-precommit-framework-tmp');

function context(): ContainerIntegrationContext {
  return {
    state: getDefaultState('test'),
    targetRoot: TEMP_DIR,
    scope: 'global',
    executionMode: 'install',
    resolvedDependencies: new Map(),
    activeSubfeatures: [],
  };
}

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
    upsertSonarHook(config, 'pre-commit', context());
    const hook = config.repos.find((r) => r.repo === 'local')?.hooks[0];
    expect(hook).toEqual({
      id: 'sonar-pre-commit',
      name: 'Sonar pre-commit scan',
      entry: 'sonar hook git-pre-commit --',
      language: 'system',
      pass_filenames: true,
      stages: ['pre-commit'],
    });
  });

  it('writes the correct hook shape for pre-push stage', () => {
    const config: PreCommitConfig = { repos: [] };
    upsertSonarHook(config, 'pre-push', context());
    const hook = config.repos.find((r) => r.repo === 'local')?.hooks[0];
    expect(hook).toEqual({
      id: 'sonar-pre-push',
      name: 'Sonar pre-push scan',
      entry: 'sonar hook git-pre-push --',
      language: 'system',
      pass_filenames: true,
      stages: ['pre-push'],
    });
  });

  it('creates a local repo with the per-stage hook when no repos exist', () => {
    const config: PreCommitConfig = { repos: [] };
    upsertSonarHook(config, 'pre-commit', context());
    const localRepo = config.repos.find((r) => r.repo === 'local');
    expect(localRepo?.hooks.some((h) => h.id === 'sonar-pre-commit')).toBe(true);
  });

  it('appends a local repo when only unrelated repos exist', () => {
    const config: PreCommitConfig = {
      repos: [{ repo: 'https://github.com/pre-commit/pre-commit-hooks', hooks: [] }],
    };
    upsertSonarHook(config, 'pre-commit', context());
    expect(config.repos).toHaveLength(2);
    expect(
      config.repos.find((r) => r.repo === 'local')?.hooks.some((h) => h.id === 'sonar-pre-commit'),
    ).toBe(true);
  });

  it('adds the hook to an existing local repo that has no sonar hook yet', () => {
    const config: PreCommitConfig = {
      repos: [
        { repo: 'local', hooks: [{ id: 'other-hook', name: 'x', entry: 'e', language: 'system' }] },
      ],
    };
    upsertSonarHook(config, 'pre-commit', context());
    const localRepo = config.repos.find((r) => r.repo === 'local');
    expect(localRepo?.hooks).toHaveLength(2);
    expect(localRepo?.hooks.some((h) => h.id === 'sonar-pre-commit')).toBe(true);
    expect(localRepo?.hooks.some((h) => h.id === 'other-hook')).toBe(true);
  });

  it('is idempotent: re-running the same stage replaces it in place', () => {
    const config: PreCommitConfig = { repos: [] };
    upsertSonarHook(config, 'pre-commit', context());
    upsertSonarHook(config, 'pre-commit', context());
    const localRepo = config.repos.find((r) => r.repo === 'local');
    expect(localRepo?.hooks.filter((h) => h.id === 'sonar-pre-commit')).toHaveLength(1);
  });

  it('lets the pre-commit and pre-push hooks coexist', () => {
    const config: PreCommitConfig = { repos: [] };
    upsertSonarHook(config, 'pre-commit', context());
    upsertSonarHook(config, 'pre-push', context());
    const ids = config.repos.find((r) => r.repo === 'local')?.hooks.map((h) => h.id);
    expect(ids).toEqual(['sonar-pre-commit', 'sonar-pre-push']);
  });

  it('migrates a same-stage legacy sonar-secrets hook in place', () => {
    const config: PreCommitConfig = {
      repos: [
        {
          repo: 'local',
          hooks: [
            {
              id: 'sonar-secrets',
              name: 'old',
              entry: 'sonar hook git-pre-commit --',
              language: 'system',
              stages: ['pre-commit'],
            },
          ],
        },
      ],
    };
    upsertSonarHook(config, 'pre-commit', context());
    const localRepo = config.repos.find((r) => r.repo === 'local');
    expect(localRepo?.hooks).toHaveLength(1);
    expect(localRepo?.hooks[0].id).toBe('sonar-pre-commit');
    expect(localRepo?.hooks.some((h) => h.id === 'sonar-secrets')).toBe(false);
  });

  it('leaves a legacy hook for the other stage untouched', () => {
    const config: PreCommitConfig = {
      repos: [
        {
          repo: 'local',
          hooks: [
            {
              id: 'sonar-secrets',
              name: 'old',
              entry: 'sonar hook git-pre-push --',
              language: 'system',
              stages: ['pre-push'],
            },
          ],
        },
      ],
    };
    upsertSonarHook(config, 'pre-commit', context());
    const localRepo = config.repos.find((r) => r.repo === 'local');
    expect(localRepo?.hooks).toHaveLength(2);
    expect(
      localRepo?.hooks.some((h) => h.id === 'sonar-secrets' && h.stages?.includes('pre-push')),
    ).toBe(true);
    expect(localRepo?.hooks.some((h) => h.id === 'sonar-pre-commit')).toBe(true);
  });

  it('appends a pre-push hook alongside a pre-commit legacy entry (no clobbering)', () => {
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
    upsertSonarHook(config, 'pre-push', context());
    const localRepo = config.repos.find((r) => r.repo === 'local');
    expect(localRepo?.hooks).toHaveLength(2);
    expect(
      localRepo?.hooks.some((h) => h.id === 'sonar-secrets' && h.stages?.includes('pre-commit')),
    ).toBe(true);
    expect(localRepo?.hooks.find((h) => h.id === 'sonar-pre-push')?.entry).toBe(
      'sonar hook git-pre-push --',
    );
  });

  it('migrates a stage-less legacy sonar-secrets hook in place (defaults to pre-commit)', () => {
    const config: PreCommitConfig = {
      repos: [
        {
          repo: 'local',
          hooks: [
            {
              id: 'sonar-secrets',
              name: 'old',
              entry: 'sonar hook git-pre-commit --',
              language: 'system',
            },
          ],
        },
      ],
    };
    upsertSonarHook(config, 'pre-commit', context());
    const localRepo = config.repos.find((r) => r.repo === 'local');
    expect(localRepo?.hooks).toHaveLength(1);
    expect(localRepo?.hooks[0].id).toBe('sonar-pre-commit');
  });

  it('preserves top-level keys that are not repos', () => {
    const config: PreCommitConfig = { default_install_hook_types: ['pre-commit'], repos: [] };
    upsertSonarHook(config, 'pre-commit', context());
    expect(config.default_install_hook_types).toEqual(['pre-commit']);
  });
});

describe('removeSonarHook', () => {
  it('removes the per-stage hook while keeping unrelated hooks', () => {
    const config: PreCommitConfig = {
      repos: [
        {
          repo: 'local',
          hooks: [
            {
              id: 'sonar-pre-commit',
              name: 'x',
              entry: 'sonar hook git-pre-commit --',
              language: 'system',
              stages: ['pre-commit'],
            },
            { id: 'other-hook', name: 'y', entry: 'e', language: 'system' },
          ],
        },
      ],
    };
    removeSonarHook(config, 'pre-commit');
    const localRepo = config.repos.find((r) => r.repo === 'local');
    expect(localRepo?.hooks.some((h) => h.id === 'sonar-pre-commit')).toBe(false);
    expect(localRepo?.hooks.some((h) => h.id === 'other-hook')).toBe(true);
  });

  it('leaves the other stage hook intact', () => {
    const config: PreCommitConfig = {
      repos: [
        {
          repo: 'local',
          hooks: [
            {
              id: 'sonar-pre-commit',
              name: 'x',
              entry: 'sonar hook git-pre-commit --',
              language: 'system',
              stages: ['pre-commit'],
            },
            {
              id: 'sonar-pre-push',
              name: 'y',
              entry: 'sonar hook git-pre-push --',
              language: 'system',
              stages: ['pre-push'],
            },
          ],
        },
      ],
    };
    removeSonarHook(config, 'pre-commit');
    const localRepo = config.repos.find((r) => r.repo === 'local');
    expect(localRepo?.hooks.map((h) => h.id)).toEqual(['sonar-pre-push']);
  });
});

describe('removeLegacySonarHook', () => {
  it('removes the sonar-secrets hook for the matching stage', () => {
    const config: PreCommitConfig = {
      repos: [
        {
          repo: 'local',
          hooks: [
            {
              id: 'sonar-secrets',
              name: 'x',
              entry: 'e',
              language: 'system',
              stages: ['pre-commit'],
            },
            { id: 'other-hook', name: 'y', entry: 'e', language: 'system' },
          ],
        },
      ],
    };
    removeLegacySonarHook(config, 'pre-commit');
    const localRepo = config.repos.find((r) => r.repo === 'local');
    expect(localRepo?.hooks.some((h) => h.id === 'sonar-secrets')).toBe(false);
    expect(localRepo?.hooks.some((h) => h.id === 'other-hook')).toBe(true);
  });

  it('leaves the sonar-secrets hook for a different stage intact', () => {
    const config: PreCommitConfig = {
      repos: [
        {
          repo: 'local',
          hooks: [
            {
              id: 'sonar-secrets',
              name: 'x',
              entry: 'e',
              language: 'system',
              stages: ['pre-push'],
            },
          ],
        },
      ],
    };
    removeLegacySonarHook(config, 'pre-commit');
    const localRepo = config.repos.find((r) => r.repo === 'local');
    expect(localRepo?.hooks.map((h) => h.id)).toEqual(['sonar-secrets']);
  });

  it('removes a stage-less legacy sonar-secrets hook when removing pre-commit', () => {
    const config: PreCommitConfig = {
      repos: [
        {
          repo: 'local',
          hooks: [
            {
              id: 'sonar-secrets',
              name: 'x',
              entry: 'e',
              language: 'system',
            },
          ],
        },
      ],
    };
    removeLegacySonarHook(config, 'pre-commit');
    const localRepo = config.repos.find((r) => r.repo === 'local');
    expect(localRepo?.hooks).toHaveLength(0);
  });

  it('does not remove the current per-stage hook id', () => {
    const config: PreCommitConfig = {
      repos: [
        {
          repo: 'local',
          hooks: [
            {
              id: 'sonar-pre-commit',
              name: 'x',
              entry: 'sonar hook git-pre-commit --',
              language: 'system',
              stages: ['pre-commit'],
            },
          ],
        },
      ],
    };
    removeLegacySonarHook(config, 'pre-commit');
    const localRepo = config.repos.find((r) => r.repo === 'local');
    expect(localRepo?.hooks.map((h) => h.id)).toEqual(['sonar-pre-commit']);
  });
});

describe('hasSonarHookInPreCommitConfig', () => {
  beforeEach(() => mkdirSync(TEMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TEMP_DIR, { recursive: true, force: true }));

  it('returns false when the config file does not exist', () => {
    expect(hasSonarHookInPreCommitConfig(TEMP_DIR)).toBe(false);
  });

  it('returns true when the config contains a legacy sonar-secrets hook in a local repo', () => {
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

  it('returns true when the config contains a new per-stage hook in a local repo', () => {
    writeFileSync(
      join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE),
      yaml.dump({
        repos: [
          {
            repo: 'local',
            hooks: [{ id: 'sonar-pre-push', name: 'x', entry: 'e', language: 'system' }],
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

describe('garbageCollectPreCommitFramework', () => {
  it('calls pre-commit gc', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(PRE_COMMIT_OK);

    try {
      await garbageCollectPreCommitFramework(TEMP_DIR);

      const calls = spawnSpy.mock.calls.map((c) => (c as [string, string[]])[1]);
      expect(calls).toEqual([['gc']]);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('does not throw when pre-commit gc fails', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(PRE_COMMIT_FAIL);

    try {
      await garbageCollectPreCommitFramework(TEMP_DIR);
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

  it('removes only Sonar hooks from the config and runs pre-commit gc', async () => {
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
    const context: ContainerIntegrationContext = {
      state: getDefaultState('test'),
      targetRoot: TEMP_DIR,
      scope: 'project',
      executionMode: 'install',
      resolvedDependencies: new Map(),
      activeSubfeatures: [],
    };

    try {
      await installer.removeFeature(context, preCommitFeature);

      const calls = spawnSpy.mock.calls.map((c) => (c as [string, string[]])[1]);
      expect(calls).toEqual([['gc']]);

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
