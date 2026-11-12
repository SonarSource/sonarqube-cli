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

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import * as changeset from '@/commands/analyze/sqaa-changeset.ts';
import { fingerprintGitChangeSet } from '@/commands/analyze/sqaa-fingerprint.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';

let tempDir: string;
let resolveSpy: ReturnType<typeof spyOn<typeof changeset, 'resolveChangeSet'>>;

function selectFiles(root: string, entries: Array<[string, string]>): void {
  const files = entries.map(([path, content]) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  });
  resolveSpy.mockResolvedValue({ files, repoRoot: root, ignored: [] });
}

beforeEach(() => {
  tempDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sqaa-fingerprint-')));
  resolveSpy = spyOn(changeset, 'resolveChangeSet');
});

afterEach(() => {
  resolveSpy.mockRestore();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('fingerprintGitChangeSet', () => {
  it('is stable when Git returns files in a different order', async () => {
    const entries: Array<[string, string]> = [
      ['z.ts', 'last'],
      ['a.ts', 'first'],
      ['m.ts', 'middle'],
    ];
    selectFiles(tempDir, entries);
    const fingerprint = await fingerprintGitChangeSet(tempDir);
    selectFiles(tempDir, [...entries].reverse());
    expect(await fingerprintGitChangeSet(tempDir)).toBe(fingerprint);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['content', [['a.ts', 'changed']]],
    ['path', [['renamed.ts', 'original']]],
    [
      'added file',
      [
        ['a.ts', 'original'],
        ['b.ts', 'new'],
      ],
    ],
    ['removed file', []],
  ] satisfies Array<[string, Array<[string, string]>]>)(
    'changes when the %s changes',
    async (_label, entries) => {
      selectFiles(tempDir, [['a.ts', 'original']]);
      const fingerprint = await fingerprintGitChangeSet(tempDir);
      selectFiles(tempDir, entries);
      expect(await fingerprintGitChangeSet(tempDir)).not.toBe(fingerprint);
    },
  );

  it('uses repository-relative paths regardless of checkout location or working directory', async () => {
    const entries: Array<[string, string]> = [['src/nested/a.ts', 'same content']];
    const firstRoot = join(tempDir, 'first');
    selectFiles(firstRoot, entries);
    const fingerprint = await fingerprintGitChangeSet(firstRoot);
    const secondRoot = join(tempDir, 'second');
    selectFiles(secondRoot, entries);
    expect(await fingerprintGitChangeSet(join(secondRoot, 'src'))).toBe(fingerprint);
  });

  it('hashes an empty change set deterministically', async () => {
    selectFiles(tempDir, []);
    expect(await fingerprintGitChangeSet(tempDir)).toBe(
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    );
  });

  it('forwards the working directory and options to the change-set selector', async () => {
    selectFiles(tempDir, []);
    const options = { staged: true };
    await fingerprintGitChangeSet(tempDir, options);
    expect(resolveSpy).toHaveBeenCalledWith(tempDir, options);
  });

  it('propagates Git selection errors instead of returning an empty fingerprint', async () => {
    const error = new CommandFailedError('Git failed');
    resolveSpy.mockRejectedValue(error);
    expect(await fingerprintGitChangeSet(tempDir).catch((err: unknown) => err)).toBe(error);
  });

  it('rejects when a selected file disappears before it is read', async () => {
    selectFiles(tempDir, [['a.ts', 'content']]);
    rmSync(join(tempDir, 'a.ts'));
    expect(await fingerprintGitChangeSet(tempDir).catch((err: unknown) => err)).toBeInstanceOf(
      CommandFailedError,
    );
  });
});
