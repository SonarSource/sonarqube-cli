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

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';
import * as nodeFs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as nodeOs from 'node:os';
import { installHooks, areHooksInstalled } from '../../src/cli/commands/integrate/claude/hooks';

const PROJECT_ROOT = '/fake/project';
const GLOBAL_DIR = '/fake/global';
const PROJECT_KEY = 'my-project';

/** Normalize path separators to forward slashes for cross-platform assertions. */
const normPath = (s: string) => s.replaceAll('\\', '/');

interface AgentSettings {
  hooks?: Record<
    string,
    Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>
  >;
  [key: string]: unknown;
}

function getSettingsWriteFor(hookType: string): AgentSettings | undefined {
  return writeFileSpy.mock.calls
    .filter(([path]) => (path as string).includes('settings.json'))
    .map(([, content]) => JSON.parse(content as string) as AgentSettings)
    .find((s) => s.hooks?.[hookType]);
}

function getScriptWriteFor(nameFragment: string): string | undefined {
  const call = writeFileSpy.mock.calls.find(([path]) => (path as string).includes(nameFragment));
  return call ? (call[1] as string) : undefined;
}

function getScriptPathFor(nameFragment: string): string | undefined {
  const call = writeFileSpy.mock.calls.find(([path]) => (path as string).includes(nameFragment));
  return call ? (call[0] as string) : undefined;
}

let writeFileSpy: Mock<Extract<(typeof fsPromises)['writeFile'], (...args: any[]) => any>>;

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

  it('returns false when settings.json does not exist', async () => {
    existsSyncSpy.mockReturnValue(false);

    const result = await areHooksInstalled(PROJECT_ROOT);

    expect(result).toBe(false);
  });

  it('looks for settings.json in the .claude subdirectory', async () => {
    existsSyncSpy.mockReturnValue(false);

    await areHooksInstalled(PROJECT_ROOT);

    const checkedPath = String(existsSyncSpy.mock.calls[0][0]);
    expect(checkedPath).toContain('.claude');
    expect(checkedPath).toContain('settings.json');
  });

  it('returns true when PreToolUse has a sonar-secrets command', async () => {
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

    const result = await areHooksInstalled(PROJECT_ROOT);

    expect(result).toBe(true);
  });

  it('returns false when settings has no hooks property', async () => {
    readFileSpy.mockResolvedValue(JSON.stringify({}));

    const result = await areHooksInstalled(PROJECT_ROOT);

    expect(result).toBe(false);
  });

  it('returns false when PreToolUse is empty', async () => {
    readFileSpy.mockResolvedValue(JSON.stringify({ hooks: { PreToolUse: [] } }));

    const result = await areHooksInstalled(PROJECT_ROOT);

    expect(result).toBe(false);
  });

  it('returns false when PreToolUse entry does not reference sonar-secrets', async () => {
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [{ type: 'command', command: '/usr/local/bin/other-tool.sh', timeout: 60 }],
          },
        ],
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(settings));

    const result = await areHooksInstalled(PROJECT_ROOT);

    expect(result).toBe(false);
  });

  it('returns false when settings.json contains malformed JSON', async () => {
    readFileSpy.mockResolvedValue('{ invalid json !!!');

    const result = await areHooksInstalled(PROJECT_ROOT);

    expect(result).toBe(false);
  });
});

describe('installHooks', () => {
  let existsSyncSpy: Mock<Extract<(typeof nodeFs)['existsSync'], (...args: any[]) => any>>;
  let mkdirSyncSpy: Mock<Extract<(typeof nodeFs)['mkdirSync'], (...args: any[]) => any>>;
  let readFileSpy: Mock<Extract<(typeof fsPromises)['readFile'], (...args: any[]) => any>>;
  let platformSpy: Mock<Extract<(typeof nodeOs)['platform'], (...args: any[]) => any>>;

  beforeEach(() => {
    existsSyncSpy = spyOn(nodeFs, 'existsSync').mockReturnValue(false);
    mkdirSyncSpy = spyOn(nodeFs, 'mkdirSync').mockReturnValue(undefined);
    readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValue('{"hooks":{}}');
    writeFileSpy = spyOn(fsPromises, 'writeFile').mockResolvedValue(undefined);
    platformSpy = spyOn(nodeOs, 'platform').mockReturnValue('linux');
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    mkdirSyncSpy.mockRestore();
    readFileSpy.mockRestore();
    writeFileSpy.mockRestore();
    platformSpy.mockRestore();
  });

  it('writes the pretool-secrets script file', async () => {
    await installHooks(PROJECT_ROOT);

    expect(getScriptPathFor('pretool-secrets')).toBeDefined();
  });

  it('writes the prompt-secrets script file', async () => {
    await installHooks(PROJECT_ROOT);

    expect(getScriptPathFor('prompt-secrets')).toBeDefined();
  });

  it('does not write the posttool-a3s script when installA3s is false', async () => {
    await installHooks(PROJECT_ROOT, undefined, false);

    expect(getScriptPathFor('posttool-a3s')).toBeUndefined();
  });

  it('does not write the posttool-a3s script when projectKey is not provided', async () => {
    await installHooks(PROJECT_ROOT, undefined, true);

    expect(getScriptPathFor('posttool-a3s')).toBeUndefined();
  });

  it('writes the posttool-a3s script when installA3s is true and projectKey is provided', async () => {
    await installHooks(PROJECT_ROOT, undefined, true, PROJECT_KEY);

    expect(getScriptPathFor('posttool-a3s')).toBeDefined();
  });

  it('installs secrets scripts to globalDir when globalDir is provided', async () => {
    await installHooks(PROJECT_ROOT, GLOBAL_DIR);

    expect(normPath(getScriptPathFor('pretool-secrets') ?? '')).toContain(GLOBAL_DIR);
  });

  it('installs secrets scripts to projectRoot when globalDir is not provided', async () => {
    await installHooks(PROJECT_ROOT);

    expect(normPath(getScriptPathFor('pretool-secrets') ?? '')).toContain(PROJECT_ROOT);
  });

  it('installs A3S script to projectRoot even when globalDir is set', async () => {
    await installHooks(PROJECT_ROOT, GLOBAL_DIR, true, PROJECT_KEY);

    const a3sPath = normPath(getScriptPathFor('posttool-a3s') ?? '');
    expect(a3sPath).toContain(PROJECT_ROOT);
    expect(a3sPath).not.toContain(GLOBAL_DIR);
  });

  it('writes a PreToolUse hook entry with Read matcher', async () => {
    await installHooks(PROJECT_ROOT);

    const settings = getSettingsWriteFor('PreToolUse');
    expect(settings?.hooks?.PreToolUse?.[0]?.matcher).toBe('Read');
  });

  it('writes a UserPromptSubmit hook entry with wildcard matcher', async () => {
    await installHooks(PROJECT_ROOT);

    const settings = getSettingsWriteFor('UserPromptSubmit');
    expect(settings?.hooks?.UserPromptSubmit?.[0]?.matcher).toBe('*');
  });

  it('writes a PostToolUse hook entry with Edit|Write matcher when A3S is enabled', async () => {
    await installHooks(PROJECT_ROOT, undefined, true, PROJECT_KEY);

    const settings = getSettingsWriteFor('PostToolUse');
    expect(settings?.hooks?.PostToolUse?.[0]?.matcher).toBe('Edit|Write');
  });

  it('uses a relative command path for project scope (no globalDir)', async () => {
    await installHooks(PROJECT_ROOT);

    const settings = getSettingsWriteFor('PreToolUse');
    const command = settings?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
    expect(String(command).startsWith('.claude')).toBe(true);
  });

  it('uses an absolute command path for global scope (with globalDir)', async () => {
    await installHooks(PROJECT_ROOT, GLOBAL_DIR);

    const settings = getSettingsWriteFor('PreToolUse');
    const command = settings?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
    expect(normPath(String(command))).toContain(GLOBAL_DIR);
  });

  it('uses a relative command path for the A3S hook regardless of globalDir', async () => {
    await installHooks(PROJECT_ROOT, GLOBAL_DIR, true, PROJECT_KEY);

    const settings = getSettingsWriteFor('PostToolUse');
    const command = settings?.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command;
    expect(String(command).startsWith('.claude')).toBe(true);
  });

  it('preserves existing unrelated settings when settings.json already exists', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSpy.mockResolvedValue(JSON.stringify({ theme: 'dark', hooks: {} }));

    await installHooks(PROJECT_ROOT);

    const allWrites = (writeFileSpy.mock.calls as Array<[unknown, unknown]>)
      .filter(([path]) => String(path).includes('settings.json'))
      .map(([, content]) => JSON.parse(String(content)) as AgentSettings);
    expect(allWrites.every((s) => (s as { theme?: string }).theme === 'dark')).toBe(true);
  });

  it('replaces existing sonar-secrets hook entry rather than appending', async () => {
    existsSyncSpy.mockReturnValue(true);
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [
              { type: 'command', command: '.claude/hooks/sonar-secrets/old.sh', timeout: 60 },
            ],
          },
        ],
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(existing));

    await installHooks(PROJECT_ROOT);

    const settings = getSettingsWriteFor('PreToolUse');
    expect(settings?.hooks?.PreToolUse).toHaveLength(1);
  });

  it('preserves existing non-sonar PostToolUse entries when adding A3S hook', async () => {
    existsSyncSpy.mockReturnValue(true);
    const existing = {
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo ran', timeout: 60 }] },
        ],
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(existing));

    await installHooks(PROJECT_ROOT, undefined, true, PROJECT_KEY);

    const settings = getSettingsWriteFor('PostToolUse');
    const bashEntry = settings?.hooks?.PostToolUse?.find((e) => e.matcher === 'Bash');
    expect(bashEntry).toBeDefined();
  });

  it('pretool-secrets script contains the sonar analyze secrets command', async () => {
    await installHooks(PROJECT_ROOT);

    expect(getScriptWriteFor('pretool-secrets')).toContain('sonar analyze secrets');
  });

  it('posttool-a3s script contains the projectKey', async () => {
    await installHooks(PROJECT_ROOT, undefined, true, PROJECT_KEY);

    expect(getScriptWriteFor('posttool-a3s')).toContain(PROJECT_KEY);
  });

  it('writes a .sh script on Unix platforms', async () => {
    await installHooks(PROJECT_ROOT);

    expect(getScriptPathFor('pretool-secrets')).toContain('.sh');
  });

  it('writes a .ps1 script on Windows platforms', async () => {
    platformSpy.mockReturnValue('win32');

    await installHooks(PROJECT_ROOT);

    expect(getScriptPathFor('pretool-secrets')).toContain('.ps1');
  });

  it('does not throw when a file system error occurs', async () => {
    writeFileSpy.mockRejectedValue(new Error('ENOENT: no such file'));

    const actual = await installHooks(PROJECT_ROOT);

    expect(actual).toBeUndefined();
  });
});
