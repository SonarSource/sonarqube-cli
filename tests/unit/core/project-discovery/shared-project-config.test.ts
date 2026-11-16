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

import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, mock } from 'bun:test';

import {
  SHARED_PROJECT_CONFIG_FILE_NAME,
  SONARCLOUD_URL,
  SONARCLOUD_US_URL,
} from '@/core/config-constants.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import {
  type ConfigItem,
  InvalidSharedProjectConfigError,
  type SharedProjectConfigEntry,
  SharedProjectConfigFileImpl,
  SharedProjectConfigRepositoryImpl,
  throwOnInvalidConfig,
} from '@/core/project-discovery/shared-project-config.ts';

/** Any folder: these tests check what is read and written, not where it resolves. */
const anyRoot = () => expect.any(String) as unknown as string;

function items(...entries: SharedProjectConfigEntry[]): ConfigItem[] {
  return entries.map((entry) => ({ entry, root: anyRoot() }));
}

function tempDir(name: string): string {
  const dir = join(tmpdir(), `shared-project-config-ut-${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return canonicalizePath(dir);
}

function writeConfig(dir: string, content: string): void {
  writeFileSync(join(dir, SHARED_PROJECT_CONFIG_FILE_NAME), content);
}

/** Wraps a raw entry under the `project` container, as a single-project config holds it. */
function writeProjectConfig(dir: string, project: unknown): void {
  writeConfig(dir, JSON.stringify({ project }));
}

describe('SharedProjectConfigRepositoryImpl.load', () => {
  it('resolves a Cloud entry', async () => {
    const dir = tempDir('cloud');
    mkdirSync(join(dir, 'services/eu'), { recursive: true });
    writeProjectConfig(dir, {
      region: 'eu',
      organization: 'acme',
      projectKey: 'acme_eu',
      path: 'services/eu',
    });

    try {
      const mappings = await new SharedProjectConfigRepositoryImpl().load(dir);
      expect(mappings).toEqual([
        {
          projectRoot: canonicalizePath(join(dir, 'services/eu')),
          projectKey: 'acme_eu',
          serverUrl: SONARCLOUD_URL,
          organization: 'acme',
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a Cloud entry in the US region', async () => {
    const dir = tempDir('cloud-us');
    writeProjectConfig(dir, {
      region: 'us',
      organization: 'acme',
      projectKey: 'acme_us',
      path: '.',
    });

    try {
      const mappings = await new SharedProjectConfigRepositoryImpl().load(dir);
      expect(mappings[0]?.serverUrl).toBe(SONARCLOUD_US_URL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains a custom Cloud URL and organization', async () => {
    const dir = tempDir('cloud-custom');
    writeProjectConfig(dir, {
      serverUrl: 'https://sc-staging.io',
      organization: 'acme',
      projectKey: 'acme_staging',
      path: '.',
    });
    try {
      const mappings = await new SharedProjectConfigRepositoryImpl().load(dir);
      expect(mappings).toEqual([
        {
          projectRoot: dir,
          projectKey: 'acme_staging',
          serverUrl: 'https://sc-staging.io',
          organization: 'acme',
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a Server entry', async () => {
    const dir = tempDir('server');
    mkdirSync(join(dir, 'services/onprem'), { recursive: true });
    writeProjectConfig(dir, {
      serverUrl: 'https://sonarqube.internal',
      projectKey: 'onprem_key',
      path: 'services/onprem',
    });

    try {
      const mappings = await new SharedProjectConfigRepositoryImpl().load(dir);
      expect(mappings).toEqual([
        {
          projectRoot: canonicalizePath(join(dir, 'services/onprem')),
          projectKey: 'onprem_key',
          serverUrl: 'https://sonarqube.internal',
          organization: undefined,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array when the file is missing', async () => {
    const dir = tempDir('missing');
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array for invalid JSON', async () => {
    const dir = tempDir('bad-json');
    writeConfig(dir, '{ not valid json ]');
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array when the root is an array (the old multi-entry format)', async () => {
    const dir = tempDir('array-root');
    writeConfig(
      dir,
      JSON.stringify([{ serverUrl: 'https://sq.example', projectKey: 'x', path: '.' }]),
    );
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array when the root has no "project" field (the old unwrapped format)', async () => {
    const dir = tempDir('no-project-field');
    writeConfig(
      dir,
      JSON.stringify({ serverUrl: 'https://sq.example', projectKey: 'x', path: '.' }),
    );
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array when "project" is not an object', async () => {
    const dir = tempDir('project-not-object');
    writeConfig(dir, JSON.stringify({ project: 'nope' }));
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array when the project entry is missing projectKey or path', async () => {
    const dir = tempDir('missing-fields');
    writeProjectConfig(dir, { serverUrl: 'https://sq.example', projectKey: 'x' });
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['projectKey', { serverUrl: 'https://sq.example', projectKey: 'x\nforged', path: '.' }],
    ['path', { serverUrl: 'https://sq.example', projectKey: 'x', path: '.\r\nforged' }],
  ])('returns an empty array when %s spans several lines', async (_field, entry) => {
    const dir = tempDir('multiline');
    writeProjectConfig(dir, entry);
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array for an invalid region value', async () => {
    const dir = tempDir('bad-region');
    writeProjectConfig(dir, { region: 'mars', organization: 'acme', projectKey: 'x', path: '.' });
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array for a project entry with neither serverUrl nor region/organization', async () => {
    const dir = tempDir('neither');
    writeProjectConfig(dir, { projectKey: 'x', path: '.' });
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array for a project entry mixing serverUrl with region/organization', async () => {
    const dir = tempDir('mixed');
    writeProjectConfig(dir, {
      serverUrl: 'https://sq.example',
      region: 'eu',
      organization: 'acme',
      projectKey: 'x',
      path: '.',
    });
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array when "path" escapes the directory holding the config via "../"', async () => {
    const dir = tempDir('escape-relative');
    writeProjectConfig(dir, {
      serverUrl: 'https://sq.example',
      projectKey: 'x',
      path: '../../../../etc',
    });
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array when "path" is absolute', async () => {
    const dir = tempDir('escape-absolute');
    writeProjectConfig(dir, {
      serverUrl: 'https://sq.example',
      projectKey: 'x',
      path: process.platform === 'win32' ? 'C:\\Windows' : '/etc',
    });
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a "path" that stays within the directory holding the config', async () => {
    const dir = tempDir('contained');
    mkdirSync(join(dir, 'b'));
    writeProjectConfig(dir, {
      serverUrl: 'https://sq.example',
      projectKey: 'x',
      path: 'a/../b',
    });
    try {
      const mappings = await new SharedProjectConfigRepositoryImpl().load(dir);
      expect(mappings[0]?.projectRoot).toBe(canonicalizePath(join(dir, 'b')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array when "path" is empty', async () => {
    const dir = tempDir('empty-path');
    writeProjectConfig(dir, { serverUrl: 'https://sq.example', projectKey: 'x', path: '' });
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array when "path" escapes through a symlinked intermediate directory', async () => {
    const dir = tempDir('escape-symlink');
    const outside = tempDir('escape-symlink-outside');
    mkdirSync(join(outside, 'secret'));
    writeProjectConfig(dir, {
      serverUrl: 'https://sq.example',
      projectKey: 'x',
      // "vendor" is a symlink resolving outside `dir`; "secret" exists under its target.
      path: 'vendor/secret',
    });
    symlinkSync(outside, join(dir, 'vendor'));
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('returns an empty array when "path" points to a directory that does not exist', async () => {
    const dir = tempDir('missing-target');
    writeProjectConfig(dir, {
      serverUrl: 'https://sq.example',
      projectKey: 'x',
      path: 'services/never-created',
    });
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array when "path" points to a regular file rather than a directory', async () => {
    const dir = tempDir('path-is-file');
    writeFileSync(join(dir, 'not-a-directory'), 'x');
    writeProjectConfig(dir, {
      serverUrl: 'https://sq.example',
      projectKey: 'x',
      path: 'not-a-directory',
    });
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a legacy single "project" field as a one-element array', async () => {
    const dir = tempDir('load-legacy');
    writeProjectConfig(dir, {
      serverUrl: 'https://sq.example',
      projectKey: 'x',
      path: '.',
    });
    try {
      const mappings = await new SharedProjectConfigRepositoryImpl().load(dir);
      expect(mappings).toEqual([
        {
          projectRoot: dir,
          projectKey: 'x',
          serverUrl: 'https://sq.example',
          organization: undefined,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves every entry in a "projects" array (monorepo)', async () => {
    const dir = tempDir('load-projects');
    mkdirSync(join(dir, 'project1'));
    mkdirSync(join(dir, 'project2'));
    writeConfig(
      dir,
      JSON.stringify({
        projects: [
          { serverUrl: 'https://sq.example', projectKey: 'proj1', path: 'project1' },
          { serverUrl: 'https://sq.example', projectKey: 'proj2', path: 'project2' },
        ],
      }),
    );
    try {
      const mappings = await new SharedProjectConfigRepositoryImpl().load(dir);
      expect(mappings).toEqual([
        {
          projectRoot: canonicalizePath(join(dir, 'project1')),
          projectKey: 'proj1',
          serverUrl: 'https://sq.example',
          organization: undefined,
        },
        {
          projectRoot: canonicalizePath(join(dir, 'project2')),
          projectKey: 'proj2',
          serverUrl: 'https://sq.example',
          organization: undefined,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers "projects" over a stray "project" field when both are present', async () => {
    const dir = tempDir('load-precedence');
    writeConfig(
      dir,
      JSON.stringify({
        project: { serverUrl: 'https://sq.example', projectKey: 'legacy', path: '.' },
        projects: [{ serverUrl: 'https://sq.example', projectKey: 'monorepo', path: '.' }],
      }),
    );
    try {
      const mappings = await new SharedProjectConfigRepositoryImpl().load(dir);
      expect(mappings.map((m) => m.projectKey)).toEqual(['monorepo']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips an individually-invalid entry inside "projects" without dropping the others', async () => {
    const dir = tempDir('load-partial-invalid');
    mkdirSync(join(dir, 'project2'));
    writeConfig(
      dir,
      JSON.stringify({
        projects: [
          { serverUrl: 'https://sq.example', projectKey: 'missing-path' },
          { serverUrl: 'https://sq.example', projectKey: 'proj2', path: 'project2' },
        ],
      }),
    );
    try {
      const mappings = await new SharedProjectConfigRepositoryImpl().load(dir);
      expect(mappings.map((m) => m.projectKey)).toEqual(['proj2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array when "projects" is present but not an array', async () => {
    const dir = tempDir('load-projects-not-array');
    writeConfig(dir, JSON.stringify({ projects: 'nope' }));
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SharedProjectConfigFileImpl.writeItems', () => {
  it('writes a Server entry that round-trips through load()', async () => {
    const dir = tempDir('write-server');
    mkdirSync(join(dir, 'services/onprem'), { recursive: true });
    try {
      const file = new SharedProjectConfigFileImpl();
      await file.writeItems(
        dir,
        items({
          projectKey: 'onprem_key',
          path: 'services/onprem',
          serverUrl: 'https://sonarqube.internal',
        }),
      );

      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([
        {
          projectRoot: canonicalizePath(join(dir, 'services/onprem')),
          projectKey: 'onprem_key',
          serverUrl: 'https://sonarqube.internal',
          organization: undefined,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a Cloud entry that round-trips through load()', async () => {
    const dir = tempDir('write-cloud');
    try {
      const file = new SharedProjectConfigFileImpl();
      await file.writeItems(
        dir,
        items({
          projectKey: 'acme_us',
          path: '.',
          region: 'us',
          organization: 'acme',
        }),
      );

      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toEqual([
        {
          projectRoot: canonicalizePath(join(dir, '.')),
          projectKey: 'acme_us',
          serverUrl: SONARCLOUD_US_URL,
          organization: 'acme',
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('overwrites an existing entry rather than appending to it', async () => {
    const dir = tempDir('overwrite');
    try {
      const file = new SharedProjectConfigFileImpl();
      await file.writeItems(
        dir,
        items({ projectKey: 'first', path: '.', serverUrl: 'https://a.example' }),
      );
      await file.writeItems(
        dir,
        items({ projectKey: 'second', path: '.', serverUrl: 'https://b.example' }),
      );

      const mappings = await new SharedProjectConfigRepositoryImpl().load(dir);
      expect(mappings[0]?.projectKey).toBe('second');
      expect(mappings[0]?.serverUrl).toBe('https://b.example');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('nests the written entry under a "project" field, leaving room for future top-level fields', async () => {
    const dir = tempDir('write-shape');
    try {
      const file = new SharedProjectConfigFileImpl();
      await file.writeItems(
        dir,
        items({ projectKey: 'x', path: '.', serverUrl: 'https://sq.example' }),
      );

      const raw = JSON.parse(readFileSync(join(dir, SHARED_PROJECT_CONFIG_FILE_NAME), 'utf-8'));
      expect(raw).toEqual({
        project: { projectKey: 'x', path: '.', serverUrl: 'https://sq.example' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves other top-level fields already in the file when overwriting "project"', async () => {
    const dir = tempDir('preserve-siblings');
    writeConfig(dir, JSON.stringify({ someFutureField: 'keep-me' }));
    try {
      const file = new SharedProjectConfigFileImpl();
      await file.writeItems(
        dir,
        items({ projectKey: 'x', path: '.', serverUrl: 'https://sq.example' }),
      );

      const raw = JSON.parse(readFileSync(join(dir, SHARED_PROJECT_CONFIG_FILE_NAME), 'utf-8'));
      expect(raw).toEqual({
        someFutureField: 'keep-me',
        project: { projectKey: 'x', path: '.', serverUrl: 'https://sq.example' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects the write instead of clobbering a file it could not parse', async () => {
    const dir = tempDir('unreadable-existing');
    writeConfig(dir, '{ not valid json ]');
    try {
      const file = new SharedProjectConfigFileImpl();
      const before = readFileSync(join(dir, SHARED_PROJECT_CONFIG_FILE_NAME), 'utf-8');

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        file.writeItems(
          dir,
          items({ projectKey: 'x', path: '.', serverUrl: 'https://sq.example' }),
        ),
      ).rejects.toThrow();

      expect(readFileSync(join(dir, SHARED_PROJECT_CONFIG_FILE_NAME), 'utf-8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes several entries as a projects array, dropping a previous project entry', async () => {
    const dir = tempDir('save-several');
    writeConfig(dir, JSON.stringify({ project: { projectKey: 'old', path: '.', serverUrl: 'x' } }));
    mkdirSync(join(dir, 'api'), { recursive: true });
    try {
      const file = new SharedProjectConfigFileImpl();
      const root = { projectKey: 'root', path: '.', serverUrl: 'https://sq.example' };
      const api = { projectKey: 'api', path: 'api', serverUrl: 'https://sq.example' };
      await file.writeItems(dir, items(root, api));

      const raw = JSON.parse(readFileSync(join(dir, SHARED_PROJECT_CONFIG_FILE_NAME), 'utf-8'));
      expect(raw).toEqual({ projects: [root, api] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a lone entry as project, dropping a previous projects array', async () => {
    const dir = tempDir('save-one');
    writeConfig(dir, JSON.stringify({ projects: [], keep: true }));
    try {
      const file = new SharedProjectConfigFileImpl();
      const root = { projectKey: 'root', path: '.', serverUrl: 'https://sq.example' };
      await file.writeItems(dir, items(root));

      const raw = JSON.parse(readFileSync(join(dir, SHARED_PROJECT_CONFIG_FILE_NAME), 'utf-8'));
      expect(raw).toEqual({ keep: true, project: root });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects the write when the existing root is not a JSON object (old array format)', async () => {
    const dir = tempDir('unreadable-array');
    writeConfig(
      dir,
      JSON.stringify([{ serverUrl: 'https://sq.example', projectKey: 'x', path: '.' }]),
    );
    try {
      const file = new SharedProjectConfigFileImpl();

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        file.writeItems(
          dir,
          items({ projectKey: 'x', path: '.', serverUrl: 'https://sq.example' }),
        ),
      ).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SharedProjectConfigFileImpl item handling', () => {
  const entry = { projectKey: 'k', path: '.', serverUrl: 'https://sq.example' };
  const future = { projectKey: 'future', path: 'api', region: 'mars', organization: 'o' };

  async function readWith(content: string | undefined, onInvalid = throwOnInvalidConfig) {
    const dir = tempDir('items');
    try {
      if (content !== undefined) writeConfig(dir, content);
      return await new SharedProjectConfigFileImpl().readItems(dir, onInvalid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function readCollecting(content: string) {
    const problems: string[] = [];
    return readWith(content, (error) => problems.push(error.message)).then((read) => ({
      read,
      problems,
    }));
  }

  it('reads the projects array, which takes precedence over a project entry', async () => {
    const other = { ...entry, projectKey: 'other' };
    expect(await readWith(JSON.stringify({ project: entry, projects: [other] }))).toEqual(
      items(other),
    );
  });

  it('reads a lone project entry, and nothing without a file', async () => {
    expect(await readWith(JSON.stringify({ project: entry }))).toEqual(items(entry));
    expect(await readWith(undefined)).toEqual([]);
  });

  it('resolves each item to the canonical folder its path names', async () => {
    const dir = tempDir('roots');
    try {
      writeConfig(dir, JSON.stringify({ projects: [entry, { ...entry, path: 'api' }] }));

      const read = await new SharedProjectConfigFileImpl().readItems(dir, throwOnInvalidConfig);

      expect(read.map((item) => item.root)).toEqual([dir, join(dir, 'api')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an invalid file once and reads nothing from it', async () => {
    for (const [content, problem] of [
      ['{ not json', 'is not valid JSON'],
      [JSON.stringify([entry]), 'does not contain a JSON object'],
      [JSON.stringify({ projects: {} }), 'must contain a projects array'],
    ]) {
      expect(await readCollecting(content)).toEqual({
        read: [],
        problems: [expect.stringContaining(problem) as string],
      });
    }
  });

  it('reports each item outside the schema and each repeated folder, keeping the rest', async () => {
    const again = { ...entry, projectKey: 'again', path: './' };
    const content = JSON.stringify({ projects: [entry, future, 'text', again] });

    const { read, problems } = await readCollecting(content);

    expect(read).toEqual(items(entry));
    expect(problems).toEqual([
      expect.stringMatching(/^Project future in .* does not match the expected format$/) as string,
      expect.stringMatching(/^Project #3 in .* does not match the expected format$/) as string,
      expect.stringMatching(/^Project again in .* links \., which an earlier/) as string,
    ]);
  });

  it('writes an absolute path inside the config folder back relative to it', async () => {
    const dir = tempDir('write-absolute');
    writeConfig(dir, JSON.stringify({ project: { ...entry, path: join(dir, 'api') } }));
    try {
      const file = new SharedProjectConfigFileImpl();
      const read = await file.readItems(dir, throwOnInvalidConfig);
      await file.writeItems(dir, read);

      expect(read.map((item) => item.root)).toEqual([join(dir, 'api')]);
      const raw = JSON.parse(readFileSync(join(dir, SHARED_PROJECT_CONFIG_FILE_NAME), 'utf-8'));
      expect(raw).toEqual({ project: { ...entry, path: 'api' } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports each path outside the config folder, absolute or relative', async () => {
    const absolute = { ...entry, projectKey: 'absolute', path: resolve('/elsewhere/api') };
    const parent = { ...entry, projectKey: 'parent', path: '../api' };

    const { read, problems } = await readCollecting(
      JSON.stringify({ projects: [absolute, parent] }),
    );

    expect(read).toEqual([]);
    expect(problems).toEqual([
      expect.stringMatching(/^Project absolute in .* links .*api, which is outside /) as string,
      expect.stringMatching(/^Project parent in .* links \.\.\/api, which is outside /) as string,
    ]);
  });

  it('stops at the first problem when the handler throws', async () => {
    /* eslint-disable @typescript-eslint/await-thenable */
    await expect(readWith('{ not json')).rejects.toThrow(InvalidSharedProjectConfigError);
    await expect(readWith(JSON.stringify({ projects: [entry, future] }))).rejects.toThrow(
      'Project future',
    );
    /* eslint-enable @typescript-eslint/await-thenable */
  });

  it('writes an untouched item back with its path as written', async () => {
    const dir = tempDir('write-as-read');
    const spelled = { ...entry, path: './api/' };
    writeConfig(dir, JSON.stringify({ project: spelled }));
    try {
      const file = new SharedProjectConfigFileImpl();
      const read = await file.readItems(dir, throwOnInvalidConfig);
      await file.writeItems(dir, [...read, { entry, root: dir }]);

      const raw = JSON.parse(readFileSync(join(dir, SHARED_PROJECT_CONFIG_FILE_NAME), 'utf-8'));
      expect(raw).toEqual({ projects: [spelled, entry] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps fields outside the schema of an item it writes back', async () => {
    const dir = tempDir('write-extra');
    const annotated = { ...entry, comment: 'owned by team A', tags: ['x'] };
    writeConfig(dir, JSON.stringify({ project: annotated }));
    try {
      const file = new SharedProjectConfigFileImpl();
      await file.writeItems(dir, await file.readItems(dir, throwOnInvalidConfig));

      const raw = JSON.parse(readFileSync(join(dir, SHARED_PROJECT_CONFIG_FILE_NAME), 'utf-8'));
      expect(raw).toEqual({ project: annotated });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to write two items for the same folder, leaving the file as it was', async () => {
    const dir = tempDir('write-duplicates');
    writeConfig(dir, JSON.stringify({ project: entry }));
    try {
      const twice = [
        { entry, root: dir },
        { entry: { ...entry, projectKey: 'again' }, root: dir },
      ];
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(new SharedProjectConfigFileImpl().writeItems(dir, twice)).rejects.toThrow(
        'would link . more than once',
      );

      const raw = JSON.parse(readFileSync(join(dir, SHARED_PROJECT_CONFIG_FILE_NAME), 'utf-8'));
      expect(raw).toEqual({ project: entry });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a project entry beside a projects array as it was, so it stays ignored', async () => {
    const dir = tempDir('write-shadowed');
    writeConfig(dir, JSON.stringify({ project: future, projects: [] }));
    try {
      await new SharedProjectConfigFileImpl().writeItems(dir, items(entry));

      const raw = JSON.parse(readFileSync(join(dir, SHARED_PROJECT_CONFIG_FILE_NAME), 'utf-8'));
      expect(raw).toEqual({ project: future, projects: [entry] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SharedProjectConfigRepositoryImpl warnings', () => {
  function loadWithWarnings(content: string) {
    const dir = tempDir('load-warn');
    mkdirSync(join(dir, 'project2'));
    writeConfig(dir, content);
    const warnings: string[] = [];
    return new SharedProjectConfigRepositoryImpl()
      .load(dir, { warn: (message) => warnings.push(message) })
      .then((mappings) => ({ mappings, warnings }))
      .finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  it('ignores a file that is not valid JSON, with a warning', async () => {
    const { mappings, warnings } = await loadWithWarnings('{ not json');

    expect(mappings).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('is not valid JSON');
  });

  it('ignores items outside the schema with a warning each, keeping the others', async () => {
    const { mappings, warnings } = await loadWithWarnings(
      JSON.stringify({
        projects: [
          { region: 'mars', organization: 'o', projectKey: 'future', path: '.' },
          { serverUrl: 'https://sq.example', projectKey: 'proj2', path: 'project2' },
          { serverUrl: 'https://sq.example' },
        ],
      }),
    );

    expect(mappings.map((m) => m.projectKey)).toEqual(['proj2']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('Project future');
    expect(warnings[1]).toContain('Project #3');
  });

  it('ignores a repeat of an already linked folder with a warning, keeping the first', async () => {
    const { mappings, warnings } = await loadWithWarnings(
      JSON.stringify({
        projects: [
          { serverUrl: 'https://sq.example', projectKey: 'first', path: 'project2' },
          { serverUrl: 'https://sq.example', projectKey: 'second', path: './project2/' },
        ],
      }),
    );

    expect(mappings.map((m) => m.projectKey)).toEqual(['first']);
    expect(warnings).toEqual([expect.stringContaining('Project second') as string]);
  });

  it('reads an absolute path inside the config folder as the folder it names', async () => {
    const dir = tempDir('load-absolute');
    mkdirSync(join(dir, 'api'));
    writeConfig(
      dir,
      JSON.stringify({
        projects: [
          { serverUrl: 'https://sq.example', projectKey: 'absolute', path: join(dir, 'api') },
          { serverUrl: 'https://sq.example', projectKey: 'relative', path: 'api' },
        ],
      }),
    );
    const warnings: string[] = [];
    try {
      const mappings = await new SharedProjectConfigRepositoryImpl().load(dir, {
        warn: (message) => warnings.push(message),
      });

      expect(mappings.map((m) => m.projectKey)).toEqual(['absolute']);
      expect(warnings).toEqual([expect.stringContaining('Project relative') as string]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads through the file it is given', async () => {
    const dir = tempDir('injected');
    try {
      const entry = { projectKey: 'k', path: '.', serverUrl: 'https://sq.example' };
      const readItems = mock(() => Promise.resolve(items(entry)));
      const file = { readItems, writeItems: mock(() => Promise.resolve()) };

      const mappings = await new SharedProjectConfigRepositoryImpl(file).load(dir);

      expect(readItems).toHaveBeenCalledWith(dir, expect.any(Function));
      expect(mappings).toEqual([
        {
          projectRoot: dir,
          projectKey: 'k',
          serverUrl: 'https://sq.example',
          organization: undefined,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
