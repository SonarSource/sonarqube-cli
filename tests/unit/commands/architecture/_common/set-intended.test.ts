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

import * as crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test';

import type {
  ArchitectureApi,
  IntendedArchitecture,
} from '@/commands/architecture/_common/architecture-api.ts';
import { setIntended } from '@/commands/architecture/_common/set-intended.ts';
import { shellQuote } from '@/commands/architecture/_common/shell-quote.ts';
import { ForbiddenApiError } from '@/core/server/errors.ts';

const MODEL: IntendedArchitecture = {
  type: 'namespace',
  language: 'java',
  groups: [{ label: 'A' }],
  constraints: [],
};

describe('intended backup safety', () => {
  let root: string;
  let deleted: boolean;
  function api(): ArchitectureApi {
    let saved = [MODEL];
    return {
      getCurrent: () => Promise.resolve([]),
      getIntended: () => Promise.resolve(saved),
      createIntended: (models) => {
        saved = models;
        return Promise.resolve();
      },
      updateIntended: (models) => {
        saved = models;
        return Promise.resolve();
      },
      deleteIntended: () => {
        deleted = true;
        saved = [];
        return Promise.resolve();
      },
    };
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'architecture-backup-'));
    deleted = false;
  });
  afterEach(async () => {
    setSystemTime();
    await rm(root, { recursive: true, force: true });
  });
  function clear(backupDir: string) {
    return setIntended(api(), { models: [] }, { projectKey: 'test', dryRun: false, backupDir });
  }
  for (const dryRun of [false, true]) {
    it(`warns before replacing an existing model (dryRun=${dryRun})`, async () => {
      let warnings = 0;
      await setIntended(
        api(),
        { models: [{ ...MODEL, groups: [] }] },
        {
          projectKey: 'test',
          dryRun,
          backupDir: root,
          onReplacement: () => {
            warnings++;
          },
        },
      );
      expect(warnings).toBe(1);
    });
  }
  it('does not warn for an unchanged model or a creation', async () => {
    let warnings = 0;
    const options = {
      projectKey: 'test',
      dryRun: false,
      backupDir: root,
      onReplacement: () => {
        warnings++;
      },
    };
    await setIntended(api(), { models: [MODEL] }, options);
    const empty = api();
    await empty.deleteIntended();
    await setIntended(empty, { models: [MODEL] }, options);
    expect(warnings).toBe(0);
  });
  it('quotes project and backup arguments with spaces and emits permission guidance once', async () => {
    const backend = api();
    backend.updateIntended = () => Promise.reject(new ForbiddenApiError('Missing permission'));
    const result = await setIntended(
      backend,
      { models: [{ ...MODEL, groups: [{ label: 'Changed' }] }] },
      {
        projectKey: 'project with spaces',
        dryRun: false,
        backupDir: join(root, 'backups with spaces'),
      },
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    const error = result as Error & { remediationHint?: string };
    const backup = /The previous export is saved in ([^\r\n]+\.json)/.exec(error.message)?.[1];
    expect(backup).toBeDefined();
    expect(error.message).toContain(
      `--project 'project with spaces' --file ${shellQuote(backup!)}`,
    );
    expect(error.message).not.toContain('Administer Architecture permission');
    expect(error.remediationHint).toContain('Administer Architecture permission');
    expect(JSON.parse(await readFile(backup!, 'utf8')).models).toEqual([MODEL]);
    expect(deleted).toBe(false);
  });
  it('quotes Windows and POSIX paths with spaces and apostrophes for their shells', () => {
    expect(shellQuote('C:\\Users\\John Smith\\backup.json', 'win32')).toBe(
      "'C:\\Users\\John Smith\\backup.json'",
    );
    expect(shellQuote("C:\\Users\\O'Brien\\backup.json", 'win32')).toBe(
      "'C:\\Users\\O''Brien\\backup.json'",
    );
    expect(shellQuote('/home/John Smith/backup.json', 'linux')).toBe(
      "'/home/John Smith/backup.json'",
    );
  });
  it.skipIf(process.platform === 'win32')(
    'restricts model backups and their directory to the owner',
    async () => {
      const dir = join(root, 'backups');
      await mkdir(dir, { mode: 0o755 });
      const result = await clear(dir);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(result.backupPath!)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(result.backupPath!, 'utf8')).models).toEqual([MODEL]);
    },
  );
  it.skipIf(process.platform === 'win32')(
    'refuses a symlink backup directory before deleting the model',
    async () => {
      const dir = join(root, 'real');
      await mkdir(dir);
      const link = join(root, 'backups');
      await symlink(dir, link);
      expect(await clear(link).catch((error: unknown) => error)).toBeInstanceOf(Error);
      expect(deleted).toBe(false);
    },
  );
  it.skipIf(process.platform === 'win32')(
    'does not follow or overwrite an existing backup leaf on a UUID collision',
    async () => {
      setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const uuid = '00000000-0000-4000-8000-000000000001';
      const random = spyOn(crypto, 'randomUUID').mockReturnValue(uuid);
      try {
        const dir = join(root, 'backups');
        await mkdir(dir);
        const target = join(root, 'sensitive');
        await writeFile(target, 'preserve');
        await symlink(target, join(dir, `test-2026-01-01T00-00-00-000Z-${uuid}.json`));
        expect(await clear(dir).catch((error: unknown) => error)).toBeInstanceOf(Error);
        expect(await readFile(target, 'utf8')).toBe('preserve');
        expect(deleted).toBe(false);
      } finally {
        random.mockRestore();
      }
    },
  );
});
