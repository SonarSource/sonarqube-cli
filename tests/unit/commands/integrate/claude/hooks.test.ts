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

import * as nodeFs from 'node:fs';
import * as fsPromises from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';

import {
  areHooksInstalled,
  detectGlobalSecretsHook,
} from '../../../../../src/commands/integrate/claude/hooks.ts';
import { FakeConsole } from '../../../../_common/fake-console.ts';

const PROJECT_ROOT = '/fake/project';

/** Normalize path separators to forward slashes for cross-platform assertions. */
const normPath = (s: string) => s.replaceAll('\\', '/');

describe('detectGlobalSecretsHook', () => {
  let existsSyncSpy: Mock<Extract<(typeof nodeFs)['existsSync'], (...args: any[]) => any>>;
  let readFileSpy: Mock<Extract<(typeof fsPromises)['readFile'], (...args: any[]) => any>>;
  let fake: FakeConsole;

  const SETTINGS_WITH_SECRETS = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Read',
          hooks: [
            { type: 'command', command: '.claude/hooks/sonar-secrets/pretool.sh', timeout: 60 },
          ],
        },
      ],
    },
  };

  beforeEach(() => {
    fake = new FakeConsole();
    existsSyncSpy = spyOn(nodeFs, 'existsSync').mockReturnValue(true);
    readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValue('{}');
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    readFileSpy.mockRestore();
  });

  it('returns undefined and stays silent when settings.json does not exist (absent)', async () => {
    existsSyncSpy.mockReturnValue(false);

    expect(await detectGlobalSecretsHook(PROJECT_ROOT, fake)).toBeUndefined();
    const noisy = fake.calls.filter((c) => c.method === 'info' || c.method === 'warn');
    expect(noisy).toHaveLength(0);
  });

  it('returns undefined and stays silent when no PreToolUse entry references sonar-secrets (absent)', async () => {
    readFileSpy.mockResolvedValue(JSON.stringify({ hooks: { PreToolUse: [] } }));

    expect(await detectGlobalSecretsHook(PROJECT_ROOT, fake)).toBeUndefined();
    const noisy = fake.calls.filter((c) => c.method === 'info' || c.method === 'warn');
    expect(noisy).toHaveLength(0);
  });

  it('returns undefined and stays silent when settings.json contains malformed JSON (absent)', async () => {
    readFileSpy.mockResolvedValue('{ invalid json !!!');

    expect(await detectGlobalSecretsHook(PROJECT_ROOT, fake)).toBeUndefined();
    const noisy = fake.calls.filter((c) => c.method === 'info' || c.method === 'warn');
    expect(noisy).toHaveLength(0);
  });

  it('returns undefined and emits warn(...) when settings entry exists but the sonar-secrets script directory is missing (orphaned)', async () => {
    readFileSpy.mockResolvedValue(JSON.stringify(SETTINGS_WITH_SECRETS));
    existsSyncSpy.mockImplementation((p: nodeFs.PathLike) => {
      const path = normPath(String(p));
      if (path.endsWith('.claude/hooks/sonar-secrets')) return false;
      return path.endsWith('.claude/settings.json');
    });

    const result = await detectGlobalSecretsHook(PROJECT_ROOT, fake);

    expect(result).toBeUndefined();
    const warnCall = fake.calls.find(
      (c) =>
        c.method === 'warn' &&
        String(c.args[0]).includes(
          'WARNING: Global hook configuration detected, but the source files are missing',
        ),
    );
    expect(warnCall).toBeDefined();
  });

  it('returns the hook dir silently when both settings entry and sonar-secrets script directory are present (installed)', async () => {
    readFileSpy.mockResolvedValue(JSON.stringify(SETTINGS_WITH_SECRETS));
    existsSyncSpy.mockImplementation((p: nodeFs.PathLike) => {
      const path = normPath(String(p));
      return path.endsWith('.claude/settings.json') || path.endsWith('.claude/hooks/sonar-secrets');
    });

    const result = await detectGlobalSecretsHook(PROJECT_ROOT, fake);

    expect(result).toBeDefined();
    expect(normPath(result ?? '')).toEndWith('.claude/hooks/sonar-secrets');
    const infoCall = fake.calls.find((c) => c.method === 'info');
    expect(infoCall).toBeUndefined();
  });
});

describe('areHooksInstalled', () => {
  let existsSyncSpy: Mock<Extract<(typeof nodeFs)['existsSync'], (...args: any[]) => any>>;
  let readFileSpy: Mock<Extract<(typeof fsPromises)['readFile'], (...args: any[]) => any>>;

  beforeEach(() => {
    existsSyncSpy = spyOn(nodeFs, 'existsSync').mockReturnValue(true);
    readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValue('{}');
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    readFileSpy.mockRestore();
  });

  it('returns true when a sonar-secrets hook installation is detected', async () => {
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [
              { type: 'command', command: '.claude/hooks/sonar-secrets/pretool.sh', timeout: 60 },
            ],
          },
        ],
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(settings));
    existsSyncSpy.mockImplementation((p: nodeFs.PathLike) => {
      const path = normPath(String(p));
      return path.endsWith('.claude/settings.json') || path.endsWith('.claude/hooks/sonar-secrets');
    });

    expect(await areHooksInstalled(PROJECT_ROOT)).toBe(true);
  });

  it('returns false when no installation is detected', async () => {
    existsSyncSpy.mockReturnValue(false);

    expect(await areHooksInstalled(PROJECT_ROOT)).toBe(false);
  });
});
