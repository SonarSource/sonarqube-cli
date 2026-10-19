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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { readCodexManagedHooks, renderCodexInstallation } from '@/commands/system/status-codex.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

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
command = "must-not-run"
[[hooks.SubagentStart]]
[[hooks.SubagentStart.hooks]]
type = "command"
command = "must-not-run"
[[hooks.PostToolUse]]
matcher = "apply_patch"
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
      if (managed) writeFileSync(path, '[[hooks.SessionStart]]\n[[hooks.PostToolUse]]\n');
      const console = new FakeConsole();
      renderCodexInstallation('~/.codex/hooks.json', console, path);
      const shownPath = managed ? path : '~/.codex/hooks.json';
      expect(console.findCall('text', `Codex: RECORDED AS INSTALLED (${shownPath})`)).toBeDefined();
      expect(
        console.findCall('text', 'Status does not verify hook delivery to the current session.'),
      ).toBeDefined();
      expect(
        Boolean(console.findCall('text', 'Managed hook events: SessionStart, PostToolUse')),
      ).toBe(managed);
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
  ])('ignores managed configuration without hook events: %s', (content) => {
    writeFileSync(path, content);
    expect(readCodexManagedHooks(path)).toBeUndefined();
  });
});
