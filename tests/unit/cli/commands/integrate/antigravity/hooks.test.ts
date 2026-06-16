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
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from 'bun:test';

import type { IntegrationContext } from '../../../../../../src/cli/commands/integrate/_common/registry';
import {
  detectGlobalSecretsHook,
  extractScriptPathFromHookCommand,
  formatAntigravityHookCommand,
  hookScriptName,
  removeAntigravitySecretsBlock,
  resolveAntigravityHookCommandPath,
  SONAR_SECRETS_BLOCK_NAME,
  upsertAntigravitySecretsBlock,
  VIEW_FILE_MATCHER,
} from '../../../../../../src/cli/commands/integrate/antigravity/hooks';
import { ANTIGRAVITY_GLOBAL_SONAR_HOOKS_DIR } from '../../../../../../src/lib/config-constants';
import { getDefaultState } from '../../../../../../src/lib/state';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../../../src/ui';

const PROJECT_ROOT = '/fake/project';
const IS_WINDOWS = process.platform === 'win32';
const normPath = (path: string) => path.replaceAll('\\', '/');

function expectedHookCommand(scriptPath: string): string {
  const normalized = normPath(scriptPath);
  return IS_WINDOWS ? `powershell -NoProfile -File "${normalized}"` : `bash "${normalized}"`;
}

function projectPretoolHookCommand(): string {
  return expectedHookCommand(resolveAntigravityHookCommandPath(projectContext()));
}

function projectContext(): IntegrationContext {
  return {
    state: getDefaultState('test'),
    targetRoot: PROJECT_ROOT,
    scope: 'project',
    executionMode: 'install',
    attrs: {},
    resolvedDependencies: new Map(),
  };
}

describe('upsertAntigravitySecretsBlock', () => {
  it('creates the sonar-secrets block with view_file matcher and platform hook command', () => {
    const result = upsertAntigravitySecretsBlock({}, projectContext());
    const block = result[SONAR_SECRETS_BLOCK_NAME];

    expect(block?.enabled).toBe(true);
    expect(block?.PreToolUse).toHaveLength(1);
    expect(block?.PreToolUse?.[0].matcher).toBe(VIEW_FILE_MATCHER);
    const command = block?.PreToolUse?.[0].hooks[0].command ?? '';
    expect(command).toBe(projectPretoolHookCommand());
  });

  it('preserves unrelated top-level hook blocks', () => {
    const existing = {
      'other-hook': { PreToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] },
    };
    const result = upsertAntigravitySecretsBlock(existing, projectContext());

    expect(result['other-hook']).toEqual(existing['other-hook']);
    expect(result[SONAR_SECRETS_BLOCK_NAME]).toBeDefined();
  });

  it('is idempotent on re-upsert', () => {
    const first = upsertAntigravitySecretsBlock({}, projectContext());
    const second = upsertAntigravitySecretsBlock(first, projectContext());

    expect(second[SONAR_SECRETS_BLOCK_NAME]?.PreToolUse).toHaveLength(1);
  });
});

describe('removeAntigravitySecretsBlock', () => {
  it('removes only Sonar PreToolUse entries and drops an empty sonar-secrets block', () => {
    const document = {
      'other-hook': { enabled: true },
      [SONAR_SECRETS_BLOCK_NAME]: {
        enabled: true,
        PreToolUse: [
          {
            matcher: VIEW_FILE_MATCHER,
            hooks: [{ command: projectPretoolHookCommand() }],
          },
        ],
      },
    };
    const result = removeAntigravitySecretsBlock(document);

    expect(result[SONAR_SECRETS_BLOCK_NAME]).toBeUndefined();
    expect(result['other-hook']).toEqual({ enabled: true });
  });

  it('preserves unrelated PreToolUse entries and PostInvocation hooks in sonar-secrets', () => {
    const customPreToolUse = {
      matcher: 'run_command',
      hooks: [{ command: './lint.sh' }],
    };
    const postInvocation = [{ command: './notify.sh' }];
    const document = {
      [SONAR_SECRETS_BLOCK_NAME]: {
        enabled: true,
        PreToolUse: [
          customPreToolUse,
          {
            matcher: VIEW_FILE_MATCHER,
            hooks: [{ command: projectPretoolHookCommand() }],
          },
        ],
        PostInvocation: postInvocation,
      },
    };

    const result = removeAntigravitySecretsBlock(document);
    const block = result[SONAR_SECRETS_BLOCK_NAME];

    expect(block?.PreToolUse).toEqual([customPreToolUse]);
    expect(block?.PostInvocation).toEqual(postInvocation);
  });
});

describe('formatAntigravityHookCommand', () => {
  it('quotes the script path for the platform shell wrapper', () => {
    if (IS_WINDOWS) {
      expect(formatAntigravityHookCommand('C:/Users/test/pretool-secrets.ps1')).toBe(
        'powershell -NoProfile -File "C:/Users/test/pretool-secrets.ps1"',
      );
      expect(formatAntigravityHookCommand('C:/Users/with space/pretool-secrets.ps1')).toBe(
        'powershell -NoProfile -File "C:/Users/with space/pretool-secrets.ps1"',
      );
    } else {
      expect(formatAntigravityHookCommand('/tmp/pretool-secrets.sh')).toBe(
        'bash "/tmp/pretool-secrets.sh"',
      );
      expect(formatAntigravityHookCommand('/tmp/with space/pretool-secrets.sh')).toBe(
        'bash "/tmp/with space/pretool-secrets.sh"',
      );
    }
  });
});

describe('extractScriptPathFromHookCommand', () => {
  it('extracts quoted and unquoted script paths', () => {
    if (IS_WINDOWS) {
      expect(
        extractScriptPathFromHookCommand(
          'powershell -NoProfile -File "C:/Users/with space/pretool-secrets.ps1"',
        ),
      ).toBe('C:/Users/with space/pretool-secrets.ps1');
      expect(
        extractScriptPathFromHookCommand('powershell -NoProfile -File C:/tmp/pretool-secrets.ps1'),
      ).toBe('C:/tmp/pretool-secrets.ps1');
    } else {
      expect(extractScriptPathFromHookCommand('bash "/tmp/with space/pretool-secrets.sh"')).toBe(
        '/tmp/with space/pretool-secrets.sh',
      );
      expect(extractScriptPathFromHookCommand('bash /tmp/pretool-secrets.sh')).toBe(
        '/tmp/pretool-secrets.sh',
      );
    }
  });
});

describe('detectGlobalSecretsHook', () => {
  let existsSyncSpy: Mock<Extract<(typeof nodeFs)['existsSync'], (...args: never[]) => unknown>>;
  let readFileSpy: Mock<Extract<(typeof fsPromises)['readFile'], (...args: never[]) => unknown>>;

  const GLOBAL_SCRIPT = join(ANTIGRAVITY_GLOBAL_SONAR_HOOKS_DIR, hookScriptName());
  const GLOBAL_HOOK_COMMAND = expectedHookCommand(GLOBAL_SCRIPT);

  beforeEach(() => {
    setMockUi(true);
    existsSyncSpy = spyOn(nodeFs, 'existsSync').mockReturnValue(true);
    readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValue(
      JSON.stringify({
        [SONAR_SECRETS_BLOCK_NAME]: {
          enabled: true,
          PreToolUse: [
            {
              matcher: VIEW_FILE_MATCHER,
              hooks: [{ command: GLOBAL_HOOK_COMMAND, timeout: 60 }],
            },
          ],
        },
      }),
    );
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    existsSyncSpy.mockRestore();
    readFileSpy.mockRestore();
  });

  it('returns the script path when global hook and script exist', async () => {
    expect(normPath((await detectGlobalSecretsHook()) ?? '')).toBe(normPath(GLOBAL_SCRIPT));
  });

  it('returns undefined and warns when the script is missing', async () => {
    const scriptBasename = hookScriptName();
    existsSyncSpy.mockImplementation((path: nodeFs.PathLike) => {
      const normalized = String(path);
      return normalized.endsWith('hooks.json') || normalized.endsWith(scriptBasename)
        ? normalized.endsWith('hooks.json')
        : false;
    });

    expect(await detectGlobalSecretsHook()).toBeUndefined();
    const warnCall = getMockUiCalls().find((c) => c.method === 'warn');
    expect(warnCall).toBeDefined();
  });

  it('returns undefined when hooks.json is absent', async () => {
    existsSyncSpy.mockReturnValue(false);

    expect(await detectGlobalSecretsHook()).toBeUndefined();
  });

  it('returns undefined when the global sonar-secrets block is disabled', async () => {
    readFileSpy.mockResolvedValue(
      JSON.stringify({
        [SONAR_SECRETS_BLOCK_NAME]: {
          enabled: false,
          PreToolUse: [
            {
              matcher: VIEW_FILE_MATCHER,
              hooks: [{ command: GLOBAL_HOOK_COMMAND, timeout: 60 }],
            },
          ],
        },
      }),
    );

    expect(await detectGlobalSecretsHook()).toBeUndefined();
  });
});
