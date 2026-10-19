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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import {
  readCodexManagedHooks,
  renderCodexInstallation,
  resolveCodexManagedHooksPath,
} from '@/commands/system/status-codex.ts';
import logger from '@/core/observability/logger.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

describe('Codex managed hook path', () => {
  it.each(['linux', 'darwin'] as const)('uses the Unix path on %s', (platform) => {
    expect(resolveCodexManagedHooksPath(platform, {})).toBe('/etc/codex/requirements.toml');
  });

  it.each([undefined, String.raw`D:\SharedData`])(
    'uses ProgramData on win32: %s',
    (ProgramData) => {
      expect(resolveCodexManagedHooksPath('win32', { ProgramData })).toBe(
        join(ProgramData ?? String.raw`C:\ProgramData`, 'OpenAI', 'Codex', 'requirements.toml'),
      );
    },
  );

  it.each(['linux', 'win32'] as const)('keeps the test override on %s', (platform) => {
    expect(
      resolveCodexManagedHooksPath(platform, {
        __SQCLI_DEV_CODEX_REQUIREMENTS_PATH: '/isolated/requirements.toml',
      }),
    ).toBe('/isolated/requirements.toml');
  });
});

describe('Codex managed hook status', () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codex-status-'));
    path = join(directory, 'requirements.toml');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('reports the managed file and configured events without executing commands', () => {
    writeFileSync(
      path,
      `[hooks]
managed_dir = "/managed/hooks"
[[hooks.SessionStart]]
matcher = "startup|clear"
[[hooks.SessionStart.hooks]]
type = "command"
command = "/managed/hooks/sonar-vortex/build-scripts/session-start-vortex.sh"
[[hooks.SubagentStart]]
[[hooks.SubagentStart.hooks]]
type = "command"
command = "/managed/hooks/sonar-vortex/build-scripts/session-start-vortex.sh"
[[hooks.PostToolUse]]
matcher = "apply_patch"
[[hooks.PostToolUse.hooks]]
type = "command"
command = "sonar hook codex-post-tool-use"
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "another-tool stop"
`,
    );
    expect(readCodexManagedHooks(path)).toEqual({
      path,
      events: ['SessionStart', 'SubagentStart', 'PostToolUse'],
    });
  });

  it.each([true, false])(
    'renders recorded installation with managed hooks present: %s',
    (managed) => {
      if (managed)
        writeFileSync(
          path,
          '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "sonar hook agent-session-start --agent codex"\n',
        );
      const console = new FakeConsole();
      renderCodexInstallation('~/.codex/hooks.json', console, path);
      expect(
        console.findCall('text', 'Codex: RECORDED AS INSTALLED (~/.codex/hooks.json)'),
      ).toBeDefined();
      expect(
        console.findCall('text', 'Status does not verify hook delivery to the current session.'),
      ).toBeDefined();
      expect(Boolean(console.findCall('text', `Managed Sonar hooks (${path}): SessionStart`))).toBe(
        managed,
      );
    },
  );

  it.each(['absent', 'malformed', 'unreadable'])(
    'logs a debug diagnostic for %s configuration',
    (kind) => {
      const debug = spyOn(logger, 'debug').mockImplementation(() => {});
      try {
        if (kind === 'malformed') writeFileSync(path, 'invalid [toml');
        const target = kind === 'unreadable' ? directory : path;
        expect(readCodexManagedHooks(target)).toBeUndefined();
        expect(debug).toHaveBeenCalledWith(
          expect.stringContaining(`Cannot read Codex managed hooks from ${target}: `),
        );
        expect(debug.mock.calls[0]?.[0]).toMatch(/ENOENT|EISDIR|Invalid|Unexpected/i);
      } finally {
        debug.mockRestore();
      }
    },
  );

  it('ignores an absent file', () => {
    expect(readCodexManagedHooks(path)).toBeUndefined();
  });

  it.each([
    'invalid [toml',
    '',
    '[hooks]\nmanaged_dir = "/managed/hooks"',
    'hooks = "invalid"',
    'hooks = []',
    '[hooks]\nSessionStart = []',
    '[[hooks.SessionStart]]',
    '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "another-tool"',
    '[[hooks.SessionStart]]\nhooks = [1, "invalid"]',
    '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "prompt"\ncommand = "sonar hook agent-session-start"',
  ])('ignores managed configuration without hook events: %s', (content) => {
    writeFileSync(path, content);
    expect(readCodexManagedHooks(path)).toBeUndefined();
  });
});
