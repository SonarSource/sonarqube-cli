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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import {
  detectGlobalSecretsHook,
  installPreToolUseHook,
} from '../../../../../../src/cli/commands/integrate/copilot/hooks';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../../../src/ui';

const IS_WINDOWS = process.platform === 'win32';
const SCRIPT_EXT = IS_WINDOWS ? '.ps1' : '.sh';
const HOOK_FIELD = IS_WINDOWS ? 'powershell' : 'bash';

const GLOBAL_HOOKS_DIR = join(homedir(), '.copilot', 'hooks');
const GLOBAL_HOOKS_JSON = join(GLOBAL_HOOKS_DIR, 'hooks.json');

interface CopilotHookEntry {
  type: 'command';
  bash?: string;
  powershell?: string;
  timeoutSec?: number;
}

interface CopilotHooksJson {
  version: number;
  hooks: { preToolUse?: CopilotHookEntry[] };
}

describe('detectGlobalSecretsHook (copilot)', () => {
  let existsSyncSpy: ReturnType<typeof spyOn>;
  let readFileSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    existsSyncSpy?.mockRestore();
    readFileSpy?.mockRestore();
  });

  it('returns undefined and stays silent when ~/.copilot/hooks/hooks.json is missing', async () => {
    existsSyncSpy = spyOn(nodeFs, 'existsSync').mockImplementation(
      (p: nodeFs.PathLike) => String(p) !== GLOBAL_HOOKS_JSON,
    );

    const result = await detectGlobalSecretsHook();

    expect(result).toBeUndefined();
    const noisy = getMockUiCalls().filter((c) => c.method === 'info' || c.method === 'warn');
    expect(noisy).toHaveLength(0);
  });

  it('returns undefined and stays silent when no preToolUse entry references sonar-secrets', async () => {
    existsSyncSpy = spyOn(nodeFs, 'existsSync').mockReturnValue(true);
    const json: CopilotHooksJson = {
      version: 1,
      hooks: {
        preToolUse: [{ type: 'command', bash: '/some/other-tool/script.sh', timeoutSec: 30 }],
      },
    };
    readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValue(JSON.stringify(json));

    const result = await detectGlobalSecretsHook();

    expect(result).toBeUndefined();
    const noisy = getMockUiCalls().filter((c) => c.method === 'info' || c.method === 'warn');
    expect(noisy).toHaveLength(0);
  });

  it('returns undefined and emits warn(...) when the JSON references a sonar-secrets script that does not exist (orphaned)', async () => {
    const orphanScript = join(
      GLOBAL_HOOKS_DIR,
      'sonar-secrets',
      'build-scripts',
      'pretool-secrets.sh',
    );
    const json: CopilotHooksJson = {
      version: 1,
      hooks: {
        preToolUse: [{ type: 'command', bash: orphanScript, timeoutSec: 60 }],
      },
    };
    existsSyncSpy = spyOn(nodeFs, 'existsSync').mockImplementation((p: nodeFs.PathLike) => {
      const s = String(p);
      // hooks.json exists; the referenced script does not.
      if (s === GLOBAL_HOOKS_JSON) return true;
      if (s === orphanScript) return false;
      return false;
    });
    readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValue(JSON.stringify(json));

    const result = await detectGlobalSecretsHook();

    expect(result).toBeUndefined();
    const warnCall = getMockUiCalls().find(
      (c) =>
        c.method === 'warn' &&
        (c.args[0] as string).includes('Global hook configuration detected at') &&
        (c.args[0] as string).includes('Falling back to project-level installation'),
    );
    expect(warnCall).toBeDefined();
  });

  it('returns the script path and emits info(...) when both the JSON entry and the backing script exist (installed)', async () => {
    const goodScript = join(
      GLOBAL_HOOKS_DIR,
      'sonar-secrets',
      'build-scripts',
      'pretool-secrets.sh',
    );
    const json: CopilotHooksJson = {
      version: 1,
      hooks: {
        preToolUse: [{ type: 'command', bash: goodScript, timeoutSec: 60 }],
      },
    };
    existsSyncSpy = spyOn(nodeFs, 'existsSync').mockImplementation((p: nodeFs.PathLike) => {
      const s = String(p);
      return s === GLOBAL_HOOKS_JSON || s === goodScript;
    });
    readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValue(JSON.stringify(json));

    const result = await detectGlobalSecretsHook();

    expect(result).toBe(goodScript);
    const infoCall = getMockUiCalls().find(
      (c) =>
        c.method === 'info' &&
        (c.args[0] as string).includes('A global secrets scanning hook is already configured at') &&
        (c.args[0] as string).includes('Skipping project-level hook to avoid duplicate execution'),
    );
    expect(infoCall).toBeDefined();
  });

  it('recognises a sonar-secrets entry stored under the powershell field', async () => {
    const goodScript = join(
      GLOBAL_HOOKS_DIR,
      'sonar-secrets',
      'build-scripts',
      'pretool-secrets.ps1',
    );
    const json: CopilotHooksJson = {
      version: 1,
      hooks: {
        preToolUse: [{ type: 'command', powershell: goodScript, timeoutSec: 60 }],
      },
    };
    existsSyncSpy = spyOn(nodeFs, 'existsSync').mockImplementation((p: nodeFs.PathLike) => {
      const s = String(p);
      return s === GLOBAL_HOOKS_JSON || s === goodScript;
    });
    readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValue(JSON.stringify(json));

    const result = await detectGlobalSecretsHook();

    expect(result).toBe(goodScript);
  });
});

describe('installPreToolUseHook', () => {
  let projectRoot: string;

  beforeEach(() => {
    setMockUi(true);
    projectRoot = mkdtempSync(join(tmpdir(), 'sonar-copilot-project-'));
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes the script and a hooks.json with a relative-path preToolUse entry', async () => {
    await installPreToolUseHook(projectRoot, false);

    const scriptPath = join(
      projectRoot,
      '.github',
      'hooks',
      'sonar-secrets',
      'build-scripts',
      `pretool-secrets${SCRIPT_EXT}`,
    );
    expect(nodeFs.existsSync(scriptPath)).toBe(true);

    const hooksJsonPath = join(projectRoot, '.github', 'hooks', 'hooks.json');
    const json = JSON.parse(readFileSync(hooksJsonPath, 'utf-8')) as CopilotHooksJson;
    expect(json.hooks.preToolUse).toHaveLength(1);

    const entry = json.hooks.preToolUse?.[0];
    expect(entry?.type).toBe('command');
    expect(entry?.timeoutSec).toBe(60);

    const command = entry?.[HOOK_FIELD];
    expect(command).toBeDefined();
    // Relative paths use forward slashes on Windows (the production code
    // normalises backslashes to '/').
    const expectedSuffix = `sonar-secrets/build-scripts/pretool-secrets${SCRIPT_EXT}`;
    expect(command?.endsWith(expectedSuffix)).toBe(true);
    expect(command?.startsWith('/')).toBe(false);
    if (IS_WINDOWS) {
      expect(command?.includes('\\')).toBe(false);
    }
  });

  it('is idempotent — re-running yields exactly one sonar-secrets preToolUse entry', async () => {
    await installPreToolUseHook(projectRoot, false);
    await installPreToolUseHook(projectRoot, false);

    const hooksJsonPath = join(projectRoot, '.github', 'hooks', 'hooks.json');
    const json = JSON.parse(readFileSync(hooksJsonPath, 'utf-8')) as CopilotHooksJson;
    const sonarEntries = (json.hooks.preToolUse ?? []).filter((e) =>
      (e.bash ?? e.powershell ?? '').includes('sonar-secrets'),
    );
    expect(sonarEntries).toHaveLength(1);
  });

  it('preserves unrelated preToolUse entries on re-run', async () => {
    const hooksDir = join(projectRoot, '.github', 'hooks');
    nodeFs.mkdirSync(hooksDir, { recursive: true });
    const preExisting: CopilotHooksJson = {
      version: 1,
      hooks: {
        preToolUse: [{ type: 'command', bash: '/other/tool/run.sh', timeoutSec: 30 }],
      },
    };
    nodeFs.writeFileSync(join(hooksDir, 'hooks.json'), JSON.stringify(preExisting));

    await installPreToolUseHook(projectRoot, false);

    const json = JSON.parse(
      readFileSync(join(hooksDir, 'hooks.json'), 'utf-8'),
    ) as CopilotHooksJson;
    expect(json.hooks.preToolUse).toHaveLength(2);
    const otherEntry = json.hooks.preToolUse?.find((e) =>
      (e.bash ?? e.powershell ?? '').includes('/other/tool/'),
    );
    expect(otherEntry).toBeDefined();
  });

  it('global scope: writes a hooks.json entry with an absolute path under ~/.copilot/hooks/', async () => {
    // Spy out fs calls to avoid polluting the real homedir.
    const mkdirSpy = spyOn(nodeFs, 'mkdirSync').mockReturnValue(undefined);
    const writeFileSpy = spyOn(fsPromises, 'writeFile').mockResolvedValue(undefined);
    const existsSyncSpy = spyOn(nodeFs, 'existsSync').mockReturnValue(false);
    const readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValue('{"version":1,"hooks":{}}');

    try {
      await installPreToolUseHook('/unused/project', true);

      const hooksJsonWrite = (writeFileSpy.mock.calls as Array<[string, unknown]>).find(([p]) =>
        p.endsWith('hooks.json'),
      );
      expect(hooksJsonWrite).toBeDefined();

      const json = JSON.parse(String(hooksJsonWrite?.[1])) as CopilotHooksJson;
      const command = json.hooks.preToolUse?.[0]?.[HOOK_FIELD] ?? '';
      // Absolute path that starts at the global hooks dir (forward slashes on
      // Windows because production code calls `replaceAll('\\', '/')`).
      const normalisedGlobal = GLOBAL_HOOKS_DIR.replaceAll('\\', '/');
      expect(command.startsWith(normalisedGlobal)).toBe(true);
      expect(command.endsWith(`sonar-secrets/build-scripts/pretool-secrets${SCRIPT_EXT}`)).toBe(
        true,
      );
    } finally {
      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
      existsSyncSpy.mockRestore();
      readFileSpy.mockRestore();
    }
  });
});
