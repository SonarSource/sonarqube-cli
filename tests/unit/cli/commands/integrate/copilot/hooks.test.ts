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

import * as secretsInstall from '../../../../../../src/cli/commands/_common/install/secrets';
import { installHooks } from '../../../../../../src/cli/commands/integrate/copilot/hooks';
import {
  clearMockUiCalls,
  findMockUiCall,
  getMockUiCalls,
  setMockUi,
} from '../../../../../../src/ui';

const IS_WINDOWS = process.platform === 'win32';
const SCRIPT_EXT = IS_WINDOWS ? '.ps1' : '.sh';
const HOOK_FIELD = IS_WINDOWS ? 'powershell' : 'bash';

const GLOBAL_HOOKS_DIR = join(homedir(), '.copilot', 'hooks');
const GLOBAL_HOOKS_JSON = join(GLOBAL_HOOKS_DIR, 'hooks.json');
const GLOBAL_SCRIPT_PATH = join(
  GLOBAL_HOOKS_DIR,
  'sonar-secrets',
  'build-scripts',
  `pretool-secrets${SCRIPT_EXT}`,
);

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

interface GlobalHookConfig {
  /** Whether `~/.copilot/hooks/hooks.json` appears to exist on disk. */
  hooksJsonExists: boolean;
  /** The single preToolUse entry to expose via the mocked hooks.json (if any). */
  hookEntry?: CopilotHookEntry;
  /** Whether the script path referenced by `hookEntry` appears to exist on disk. */
  scriptExists?: boolean;
}

/**
 * Named factory helpers for the common global-hook scenarios. Pass one of
 * these to `withGlobalHookState` instead of constructing the config object
 * by hand.
 */
const globalHook = {
  /** No global hooks.json on disk at all. */
  absent: { hooksJsonExists: false } satisfies GlobalHookConfig,

  /** Global hooks.json exists with a healthy sonar-secrets entry. */
  healthy: (): GlobalHookConfig => ({
    hooksJsonExists: true,
    hookEntry: { type: 'command', [HOOK_FIELD]: GLOBAL_SCRIPT_PATH, timeoutSec: 60 },
    scriptExists: true,
  }),

  /** Global hooks.json exists with a sonar-secrets entry whose script is missing. */
  orphaned: (): GlobalHookConfig => ({
    hooksJsonExists: true,
    hookEntry: { type: 'command', [HOOK_FIELD]: GLOBAL_SCRIPT_PATH, timeoutSec: 60 },
    scriptExists: false,
  }),

  /** Global hooks.json exists but its single entry is unrelated to sonar-secrets. */
  withUnrelatedEntry: (bash: string): GlobalHookConfig => ({
    hooksJsonExists: true,
    hookEntry: { type: 'command', bash, timeoutSec: 30 },
    scriptExists: true,
  }),
};

/**
 * Run `fn` while the production code observes the global hook state described
 * by `config`. Spies `existsSync` and `fsPromises.readFile` for the global
 * paths; everything else passes through to the real fs so project-side
 * install side effects still hit disk and can be asserted after the call.
 * All spies are restored before yielding the return value.
 */
async function withGlobalHookState<T>(config: GlobalHookConfig, fn: () => Promise<T>): Promise<T> {
  const realExists = nodeFs.existsSync;
  const existsSyncSpy = spyOn(nodeFs, 'existsSync').mockImplementation((p: nodeFs.PathLike) => {
    const s = String(p);
    if (s === GLOBAL_HOOKS_JSON) return config.hooksJsonExists;
    const scriptPath = config.hookEntry?.bash ?? config.hookEntry?.powershell;
    if (scriptPath && s === scriptPath) return config.scriptExists ?? false;
    return realExists(p);
  });
  const readFileSpy = config.hooksJsonExists
    ? spyOn(fsPromises, 'readFile').mockResolvedValue(
        JSON.stringify({
          version: 1,
          hooks: { preToolUse: config.hookEntry ? [config.hookEntry] : [] },
        } satisfies CopilotHooksJson),
      )
    : undefined;
  try {
    return await fn();
  } finally {
    existsSyncSpy.mockRestore();
    readFileSpy?.mockRestore();
  }
}

function seedProjectHooksJson(projectRoot: string, contents: object): string {
  const hooksDir = join(projectRoot, '.github', 'hooks');
  nodeFs.mkdirSync(hooksDir, { recursive: true });
  const hooksJsonPath = join(hooksDir, 'hooks.json');
  nodeFs.writeFileSync(hooksJsonPath, JSON.stringify(contents));
  return hooksJsonPath;
}

function readHooksJson(path: string): CopilotHooksJson {
  return JSON.parse(readFileSync(path, 'utf-8')) as CopilotHooksJson;
}

describe('installHooks', () => {
  let projectRoot: string;
  let installSecretsBinarySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    projectRoot = mkdtempSync(join(tmpdir(), 'sonar-copilot-project-'));
    installSecretsBinarySpy = spyOn(secretsInstall, 'installSecretsBinary').mockResolvedValue(
      '/fake/sonar-secrets',
    );
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    rmSync(projectRoot, { recursive: true, force: true });
    installSecretsBinarySpy.mockRestore();
  });

  // Each project-scope test wraps the call in `withGlobalHookState(...)` to
  // control whether the existing-global-hook detection short-circuits the
  // install — and to hide any sonar-secrets hook the host machine may
  // already have under ~/.copilot.
  describe('project scope', () => {
    it('skips install and returns the global hook path when a healthy global hook exists', async () => {
      const result = await withGlobalHookState(globalHook.healthy(), () =>
        installHooks(projectRoot, false),
      );

      expect(result).toEqual({ hookPath: GLOBAL_SCRIPT_PATH, hookInstalled: false });
      expect(nodeFs.existsSync(join(projectRoot, '.github', 'hooks'))).toBe(false);
      expect(
        findMockUiCall('info', 'A global secrets scanning hook is already configured at'),
      ).toBeDefined();
      // The secrets binary install is still performed in the skip branch.
      expect(installSecretsBinarySpy).toHaveBeenCalledTimes(1);
    });

    it('warns and falls back to a project install when the global sonar-secrets script is orphaned', async () => {
      const result = await withGlobalHookState(globalHook.orphaned(), () =>
        installHooks(projectRoot, false),
      );

      expect(result.hookInstalled).toBe(true);
      expect(result.hookPath.includes(projectRoot)).toBe(true);
      expect(findMockUiCall('warn', 'Global hook configuration detected at')).toBeDefined();
      expect(findMockUiCall('warn', 'Falling back to project-level installation')).toBeDefined();
    });

    it('performs a project install when global hooks.json exists but has no sonar-secrets entry', async () => {
      const result = await withGlobalHookState(
        globalHook.withUnrelatedEntry('/some/other-tool/script.sh'),
        () => installHooks(projectRoot, false),
      );

      expect(result.hookInstalled).toBe(true);
      expect(result.hookPath.includes(projectRoot)).toBe(true);
      expect(getMockUiCalls().filter((c) => c.method === 'info' || c.method === 'warn')).toEqual(
        [],
      );
    });

    it('performs a project install when no global hooks.json exists', async () => {
      const result = await withGlobalHookState(globalHook.absent, () =>
        installHooks(projectRoot, false),
      );

      expect(result.hookInstalled).toBe(true);
      expect(result.hookPath.includes(projectRoot)).toBe(true);
      expect(getMockUiCalls().filter((c) => c.method === 'info' || c.method === 'warn')).toEqual(
        [],
      );
      expect(installSecretsBinarySpy).toHaveBeenCalledTimes(1);
    });

    it('writes the script and a hooks.json with a project-root-relative preToolUse entry', async () => {
      const result = await withGlobalHookState(globalHook.absent, () =>
        installHooks(projectRoot, false),
      );

      const scriptPath = join(
        projectRoot,
        '.github',
        'hooks',
        'sonar-secrets',
        'build-scripts',
        `pretool-secrets${SCRIPT_EXT}`,
      );
      expect(result).toEqual({ hookPath: scriptPath, hookInstalled: true });
      expect(nodeFs.existsSync(scriptPath)).toBe(true);

      const hooksJson = readHooksJson(join(projectRoot, '.github', 'hooks', 'hooks.json'));
      expect(hooksJson.hooks.preToolUse).toHaveLength(1);

      const entry = hooksJson.hooks.preToolUse?.[0];
      expect(entry?.type).toBe('command');
      expect(entry?.timeoutSec).toBe(60);

      // Path must be relative to the project root (Copilot CLI's session
      // cwd), not the hooks dir — Copilot resolves relative entries against
      // cwd, so a hooks-dir-relative path silently fails to find the script.
      // Forward slashes on Windows (production code normalises backslashes).
      const command = entry?.[HOOK_FIELD];
      expect(command).toBe(
        `.github/hooks/sonar-secrets/build-scripts/pretool-secrets${SCRIPT_EXT}`,
      );
      expect(command?.startsWith('/')).toBe(false);
      if (IS_WINDOWS) {
        expect(command?.includes('\\')).toBe(false);
      }
    });

    it('is idempotent — re-running yields exactly one sonar-secrets preToolUse entry', async () => {
      const [first, second] = await withGlobalHookState(globalHook.absent, async () => [
        await installHooks(projectRoot, false),
        await installHooks(projectRoot, false),
      ]);

      expect(first.hookInstalled).toBe(true);
      expect(second.hookInstalled).toBe(true);

      const hooksJson = readHooksJson(join(projectRoot, '.github', 'hooks', 'hooks.json'));
      const sonarEntries = (hooksJson.hooks.preToolUse ?? []).filter((e) =>
        (e.bash ?? e.powershell ?? '').includes('sonar-secrets'),
      );
      expect(sonarEntries).toHaveLength(1);
    });

    it('preserves unrelated preToolUse entries on re-run', async () => {
      const hooksJsonPath = seedProjectHooksJson(projectRoot, {
        version: 1,
        hooks: {
          preToolUse: [{ type: 'command', bash: '/other/tool/run.sh', timeoutSec: 30 }],
        },
      });

      await withGlobalHookState(globalHook.absent, () => installHooks(projectRoot, false));

      const hooksJson = readHooksJson(hooksJsonPath);
      expect(hooksJson.hooks.preToolUse).toHaveLength(2);
      expect(
        hooksJson.hooks.preToolUse?.find((e) =>
          (e.bash ?? e.powershell ?? '').includes('/other/tool/'),
        ),
      ).toBeDefined();
    });

    it('initialises the `hooks` key when a pre-existing hooks.json lacks it', async () => {
      // Exercises the `hooksJson.hooks ??= {}` guard: readOrInitJson returns
      // the parsed object as-is when valid JSON, so a bare `{"version":1}`
      // leaves `hooks` undefined and the install must initialise it.
      const hooksJsonPath = seedProjectHooksJson(projectRoot, { version: 1 });

      await withGlobalHookState(globalHook.absent, () => installHooks(projectRoot, false));

      const hooksJson = readHooksJson(hooksJsonPath);
      expect(hooksJson.version).toBe(1);
      expect(hooksJson.hooks.preToolUse).toHaveLength(1);
      const entry = hooksJson.hooks.preToolUse?.[0];
      expect(entry?.[HOOK_FIELD]?.includes('sonar-secrets')).toBe(true);
    });
  });

  // The global-scope install would write under the real `~/.copilot/hooks`;
  // spy out the writes so the host machine stays clean.
  describe('global scope', () => {
    let mkdirSpy: ReturnType<typeof spyOn>;
    let writeFileSpy: ReturnType<typeof spyOn>;
    let existsSyncSpy: ReturnType<typeof spyOn>;
    let readFileSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      mkdirSpy = spyOn(nodeFs, 'mkdirSync').mockReturnValue(undefined);
      writeFileSpy = spyOn(fsPromises, 'writeFile').mockResolvedValue(undefined);
      existsSyncSpy = spyOn(nodeFs, 'existsSync').mockReturnValue(false);
      readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValue('{"version":1,"hooks":{}}');
    });

    afterEach(() => {
      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
      existsSyncSpy.mockRestore();
      readFileSpy.mockRestore();
    });

    it('writes a hooks.json entry with an absolute path under ~/.copilot/hooks/', async () => {
      const result = await installHooks('/unused/project', true);

      expect(result).toEqual({ hookPath: GLOBAL_SCRIPT_PATH, hookInstalled: true });

      const hooksJsonWrite = (writeFileSpy.mock.calls as Array<[string, unknown]>).find(([p]) =>
        p.endsWith('hooks.json'),
      );
      expect(hooksJsonWrite).toBeDefined();

      // Absolute path under the global hooks dir, with forward slashes on
      // Windows (production code calls `replaceAll('\\', '/')`).
      const json = JSON.parse(String(hooksJsonWrite?.[1])) as CopilotHooksJson;
      const command = json.hooks.preToolUse?.[0]?.[HOOK_FIELD];
      expect(command).toBe(GLOBAL_SCRIPT_PATH.replaceAll('\\', '/'));
    });
  });
});
