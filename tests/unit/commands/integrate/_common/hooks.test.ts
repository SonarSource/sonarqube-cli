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

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { IntegrationContext } from '@/core/framework/features';

import {
  assertSafeSonarProjectKeyForHookScript,
  createAgentHookEntry,
  quoteWindowsHookScriptPath,
  readOrInitJson,
  resolveAgentHookCommand,
  shellDoubleQuoteBash,
  shellQuoteBash,
  UNIX_SONAR_COMMAND_GUARD,
  unixTemplate,
  upsertAgentHooks,
  WINDOWS_SONAR_COMMAND_GUARD,
  windowsTemplate,
  writeHookScript,
} from '../../../../../src/commands/integrate/_common/hooks.ts';

const IS_WINDOWS = process.platform === 'win32';

describe('unixTemplate', () => {
  it('starts with a bash shebang, includes the command guard, and embeds the command verbatim', () => {
    const body = unixTemplate('sonar hook claude-pre-tool-use');
    expect(body.startsWith('#!/bin/bash\n')).toBe(true);
    expect(body).toContain(UNIX_SONAR_COMMAND_GUARD);
    expect(body).toContain('sonar hook claude-pre-tool-use');
  });
});

describe('windowsTemplate', () => {
  it('includes the command guard, reads stdin, pipes it to the command, and propagates exit code', () => {
    const body = windowsTemplate('sonar hook claude-pre-tool-use');
    expect(body).toContain(WINDOWS_SONAR_COMMAND_GUARD);
    expect(body).toContain('$stdinData = [Console]::In.ReadToEnd()');
    expect(body).toContain('$stdinData | & sonar hook claude-pre-tool-use');
    expect(body).toContain('exit $LASTEXITCODE');
  });
});

describe('writeHookScript', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'sonar-hooks-test-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writes the correct platform body, uses the platform extension, and returns an absolute path', async () => {
    const scriptDir = join(workDir, 'scripts');

    const written = await writeHookScript(scriptDir, 'pretool', 'UNIX_BODY', 'WINDOWS_BODY');

    const expectedExt = IS_WINDOWS ? '.ps1' : '.sh';
    expect(written.endsWith(`pretool${expectedExt}`)).toBe(true);
    expect(written.startsWith(scriptDir)).toBe(true);
    expect(statSync(written).isFile()).toBe(true);
    expect(readFileSync(written, 'utf-8')).toBe(IS_WINDOWS ? 'WINDOWS_BODY' : 'UNIX_BODY');
  });

  it('creates the script directory recursively when missing', async () => {
    const scriptDir = join(workDir, 'a', 'b', 'c');

    const written = await writeHookScript(scriptDir, 'pretool', 'unix', 'windows');

    expect(statSync(scriptDir).isDirectory()).toBe(true);
    expect(statSync(written).isFile()).toBe(true);
  });

  it.skipIf(IS_WINDOWS)('writes the script with mode 0o755 on Unix', async () => {
    const scriptDir = join(workDir, 'scripts');

    const written = await writeHookScript(scriptDir, 'pretool', 'unix', 'windows');

    // Mask out file-type bits; only the permission bits matter.
    const mode = statSync(written).mode & 0o777;
    expect(mode).toBe(0o755);
  });
});

describe('assertSafeSonarProjectKeyForHookScript', () => {
  it('accepts typical SonarQube project keys', () => {
    expect(() => assertSafeSonarProjectKeyForHookScript('SonarSource_sonarqube-cli')).not.toThrow();
  });

  it('rejects keys with shell metacharacters', () => {
    expect(() => assertSafeSonarProjectKeyForHookScript('$(id)')).toThrow();
    expect(() => assertSafeSonarProjectKeyForHookScript('my project')).toThrow();
  });
});

describe('shellQuoteBash', () => {
  it('wraps values in single quotes', () => {
    expect(shellQuoteBash('a:b')).toBe("'a:b'");
  });
});

describe('shellDoubleQuoteBash', () => {
  it('wraps values in double quotes without escaping $', () => {
    expect(shellDoubleQuoteBash('${CLAUDE_PROJECT_DIR}/a.sh')).toBe('"${CLAUDE_PROJECT_DIR}/a.sh"');
  });

  it('escapes embedded double quotes, backslashes, and backticks', () => {
    expect(shellDoubleQuoteBash('a"b\\c`d')).toBe('"a\\"b\\\\c\\`d"');
  });
});

describe('quoteWindowsHookScriptPath', () => {
  it('wraps the path in double quotes so spaces survive PowerShell -File parsing', () => {
    expect(quoteWindowsHookScriptPath('C:/Users/Jane Doe/.claude/hooks/x.ps1')).toBe(
      '"C:/Users/Jane Doe/.claude/hooks/x.ps1"',
    );
  });
});

describe('resolveAgentHookCommand', () => {
  const fakeContext = (targetRoot: string, scope: 'global' | 'project'): IntegrationContext =>
    ({
      targetRoot,
      scope,
      attrs: {},
      state: {} as never,
      executionMode: 'install',
      resolvedDependencies: new Map(),
    }) as unknown as IntegrationContext;

  const SCRIPT = 'sonar-secrets/build-scripts/pretool-secrets';

  it.skipIf(IS_WINDOWS)(
    'single-quotes an absolute global path that contains a space (Unix)',
    () => {
      const command = resolveAgentHookCommand(
        fakeContext('/Users/Jane Doe/proj', 'global'),
        '.claude',
        SCRIPT,
      );
      expect(command).toBe(
        "'/Users/Jane Doe/proj/.claude/hooks/sonar-secrets/build-scripts/pretool-secrets.sh'",
      );
    },
  );

  it.skipIf(IS_WINDOWS)(
    'escapes an embedded apostrophe in targetRoot so the path stays a single Bash argument (Unix)',
    () => {
      const command = resolveAgentHookCommand(
        fakeContext("/Users/O'Brien/proj", 'global'),
        '.claude',
        SCRIPT,
      );
      // Close quote, escaped literal apostrophe, reopen quote: 'O'\''Brien'
      expect(command).toBe(
        "'/Users/O'\\''Brien/proj/.claude/hooks/sonar-secrets/build-scripts/pretool-secrets.sh'",
      );
      // Marker still present for idempotency matching.
      expect(command).toContain('sonar-secrets');
    },
  );

  it.skipIf(IS_WINDOWS)('single-quotes the relative project-scope path (Unix)', () => {
    const command = resolveAgentHookCommand(fakeContext('/tmp/proj', 'project'), '.claude', SCRIPT);
    expect(command).toBe("'.claude/hooks/sonar-secrets/build-scripts/pretool-secrets.sh'");
  });

  it.skipIf(IS_WINDOWS)(
    // Double-quoted, not single-quoted: single quotes would suppress the shell's own
    // `$var`/`${var}` expansion, leaving the literal, unexpanded token in the path instead of
    // letting Claude Code's substitution take effect.
    'anchors the project-scope path to the given placeholder instead of cwd, double-quoted so it can still expand (Unix)',
    () => {
      const command = resolveAgentHookCommand(
        fakeContext('/tmp/proj', 'project'),
        '.claude',
        SCRIPT,
        '${CLAUDE_PROJECT_DIR}',
      );
      expect(command).toBe(
        '"${CLAUDE_PROJECT_DIR}/.claude/hooks/sonar-secrets/build-scripts/pretool-secrets.sh"',
      );
    },
  );

  it.skipIf(!IS_WINDOWS)(
    'anchors the project-scope path to the given placeholder instead of cwd (Windows)',
    () => {
      const command = resolveAgentHookCommand(
        fakeContext('C:/tmp/proj', 'project'),
        '.claude',
        SCRIPT,
        '${CLAUDE_PROJECT_DIR}',
      );
      expect(command).toBe(
        'powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_PROJECT_DIR}/.claude/hooks/sonar-secrets/build-scripts/pretool-secrets.ps1"',
      );
    },
  );

  it.skipIf(IS_WINDOWS)('ignores the placeholder for global scope (Unix)', () => {
    const command = resolveAgentHookCommand(
      fakeContext('/tmp/proj', 'global'),
      '.claude',
      SCRIPT,
      '${CLAUDE_PROJECT_DIR}',
    );
    expect(command).toBe(
      "'/tmp/proj/.claude/hooks/sonar-secrets/build-scripts/pretool-secrets.sh'",
    );
  });

  it.skipIf(!IS_WINDOWS)(
    'double-quotes an absolute global path that contains a space (Windows)',
    () => {
      const command = resolveAgentHookCommand(
        fakeContext('C:/Users/Jane Doe/proj', 'global'),
        '.claude',
        SCRIPT,
      );
      expect(command).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File "');
      expect(command).toContain('/Jane Doe/');
      expect(command.endsWith('pretool-secrets.ps1"')).toBe(true);
    },
  );

  it.skipIf(IS_WINDOWS)(
    'the generated command executes through /bin/sh when the path contains a space and an apostrophe',
    () => {
      const base = mkdtempSync(join(tmpdir(), 'sonar-hook-exec-'));
      try {
        // A global-scope absolute path is what carries the space into the command.
        const targetRoot = join(base, "o'brien project dir");
        const scriptDir = join(targetRoot, '.claude', 'hooks', 'sonar-secrets', 'build-scripts');
        mkdirSync(scriptDir, { recursive: true });
        const scriptFile = join(scriptDir, 'pretool-secrets.sh');
        writeFileSync(scriptFile, '#!/bin/sh\necho HOOK_RAN\n');
        chmodSync(scriptFile, 0o755);

        const command = resolveAgentHookCommand(
          fakeContext(targetRoot, 'global'),
          '.claude',
          SCRIPT,
        );
        // Precondition: this is the bug scenario — the command really contains a space.
        expect(command).toContain(' ');

        // The agent runs the stored command through a shell; the quoting must let it execute.
        expect(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf-8' }).trim()).toBe(
          'HOOK_RAN',
        );

        // Negative control: the same path unquoted is split / mis-parsed by the shell and fails.
        // (stdio: 'ignore' keeps the expected shell error off the test log.)
        expect(() => execFileSync('/bin/sh', ['-c', scriptFile], { stdio: 'ignore' })).toThrow();
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
});

describe('createAgentHookEntry with projectDirPlaceholder', () => {
  const projectScopeContext = {
    targetRoot: '/tmp/proj',
    scope: 'project',
    attrs: {},
    state: {} as never,
    executionMode: 'install',
    resolvedDependencies: new Map(),
  } as unknown as IntegrationContext;

  it('embeds the placeholder while keeping the marker detectable for dedup', () => {
    const entry = createAgentHookEntry(
      projectScopeContext,
      '.claude',
      'PreToolUse',
      'Read',
      'sonar-secrets',
      'sonar-secrets/build-scripts/pretool-secrets',
      { projectDirPlaceholder: '${CLAUDE_PROJECT_DIR}' },
    );

    expect(entry.hookConfig.hooks[0].command).toContain('${CLAUDE_PROJECT_DIR}/');
    expect(entry.hookConfig.hooks[0].command).toContain('sonar-secrets');

    const first = upsertAgentHooks(null, [entry]);
    const second = upsertAgentHooks(first, [entry]);
    expect(second.hooks?.PreToolUse).toHaveLength(1);
  });
});

describe('upsertAgentHooks idempotency', () => {
  const fakeContext = {
    targetRoot: '/Users/Jane Doe/proj',
    scope: 'global',
    attrs: {},
    state: {} as never,
    executionMode: 'install',
    resolvedDependencies: new Map(),
  } as unknown as IntegrationContext;

  it('does not duplicate the entry when re-run with a quoted path', () => {
    const entry = createAgentHookEntry(
      fakeContext,
      '.claude',
      'PreToolUse',
      'Read',
      'sonar-secrets',
      'sonar-secrets/build-scripts/pretool-secrets',
    );

    const first = upsertAgentHooks(null, [entry]);
    const second = upsertAgentHooks(first, [entry]);

    expect(second.hooks?.PreToolUse).toHaveLength(1);
  });

  it('replaces a previously-unquoted entry (upgrade path) instead of shadowing it', () => {
    // Simulate a settings.json written by an older CLI: bare, unquoted path.
    const legacy = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [
              {
                type: 'command',
                command:
                  '/Users/Jane Doe/proj/.claude/hooks/sonar-secrets/build-scripts/pretool-secrets.sh',
                timeout: 60,
              },
            ],
          },
        ],
      },
    };
    const entry = createAgentHookEntry(
      fakeContext,
      '.claude',
      'PreToolUse',
      'Read',
      'sonar-secrets',
      'sonar-secrets/build-scripts/pretool-secrets',
    );

    const result = upsertAgentHooks(legacy, [entry]);

    expect(result.hooks?.PreToolUse).toHaveLength(1);
    // The retained entry is the freshly-quoted one.
    expect(result.hooks?.PreToolUse?.[0].hooks[0].command).toBe(entry.hookConfig.hooks[0].command);
  });
});

describe('readOrInitJson', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'sonar-readjson-test-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns the default value when the file does not exist', async () => {
    const missing = join(workDir, 'missing.json');

    const result = await readOrInitJson(missing, { hooks: {} });

    expect(result).toEqual({ hooks: {} });
  });

  it('returns the default value when the file contains malformed JSON', async () => {
    const path = join(workDir, 'bad.json');
    writeFileSync(path, '{ not valid json !!!', 'utf-8');

    const result = await readOrInitJson(path, { fallback: true });

    expect(result).toEqual({ fallback: true });
  });

  it('parses and returns the file contents when the JSON is valid', async () => {
    const path = join(workDir, 'good.json');
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: ['x'] } }), 'utf-8');

    const result = await readOrInitJson<{ hooks: { PreToolUse: string[] } }>(path, {
      hooks: { PreToolUse: [] },
    });

    expect(result.hooks.PreToolUse).toEqual(['x']);
  });
});
