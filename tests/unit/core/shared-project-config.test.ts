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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  SHARED_PROJECT_CONFIG_FILE_NAME,
  SONARCLOUD_URL,
  SONARCLOUD_US_URL,
} from '@/core/config-constants.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import { SharedProjectConfigRepositoryImpl } from '@/core/shared-project-config.ts';

function tempDir(name: string): string {
  const dir = join(tmpdir(), `shared-project-config-ut-${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, content: string): void {
  writeFileSync(join(dir, SHARED_PROJECT_CONFIG_FILE_NAME), content);
}

/** Wraps a raw entry under the `project` container, mirroring what `set()` writes. */
function writeProjectConfig(dir: string, project: unknown): void {
  writeConfig(dir, JSON.stringify({ project }));
}

describe('SharedProjectConfigFileRepository.load', () => {
  it('resolves a Cloud entry', async () => {
    const dir = tempDir('cloud');
    writeProjectConfig(dir, {
      region: 'eu',
      organization: 'acme',
      projectKey: 'acme_eu',
      path: 'services/eu',
    });

    try {
      const mapping = await new SharedProjectConfigRepositoryImpl().load(dir);
      expect(mapping).toEqual({
        projectRoot: canonicalizePath(join(dir, 'services/eu')),
        projectKey: 'acme_eu',
        serverUrl: SONARCLOUD_URL,
        organization: 'acme',
      });
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
      const mapping = await new SharedProjectConfigRepositoryImpl().load(dir);
      expect(mapping?.serverUrl).toBe(SONARCLOUD_US_URL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a Server entry', async () => {
    const dir = tempDir('server');
    writeProjectConfig(dir, {
      serverUrl: 'https://sonarqube.internal',
      projectKey: 'onprem_key',
      path: 'services/onprem',
    });

    try {
      const mapping = await new SharedProjectConfigRepositoryImpl().load(dir);
      expect(mapping).toEqual({
        projectRoot: canonicalizePath(join(dir, 'services/onprem')),
        projectKey: 'onprem_key',
        serverUrl: 'https://sonarqube.internal',
        organization: undefined,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the file is missing', async () => {
    const dir = tempDir('missing');
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for invalid JSON', async () => {
    const dir = tempDir('bad-json');
    writeConfig(dir, '{ not valid json ]');
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the root is an array (the old multi-entry format)', async () => {
    const dir = tempDir('array-root');
    writeConfig(
      dir,
      JSON.stringify([{ serverUrl: 'https://sq.example', projectKey: 'x', path: '.' }]),
    );
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the root has no "project" field (the old unwrapped format)', async () => {
    const dir = tempDir('no-project-field');
    writeConfig(
      dir,
      JSON.stringify({ serverUrl: 'https://sq.example', projectKey: 'x', path: '.' }),
    );
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when "project" is not an object', async () => {
    const dir = tempDir('project-not-object');
    writeConfig(dir, JSON.stringify({ project: 'nope' }));
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the project entry is missing projectKey or path', async () => {
    const dir = tempDir('missing-fields');
    writeProjectConfig(dir, { serverUrl: 'https://sq.example', projectKey: 'x' });
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for an invalid region value', async () => {
    const dir = tempDir('bad-region');
    writeProjectConfig(dir, { region: 'mars', organization: 'acme', projectKey: 'x', path: '.' });
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a project entry with neither serverUrl nor region/organization', async () => {
    const dir = tempDir('neither');
    writeProjectConfig(dir, { projectKey: 'x', path: '.' });
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a project entry mixing serverUrl with region/organization', async () => {
    const dir = tempDir('mixed');
    writeProjectConfig(dir, {
      serverUrl: 'https://sq.example',
      region: 'eu',
      organization: 'acme',
      projectKey: 'x',
      path: '.',
    });
    try {
      expect(await new SharedProjectConfigRepositoryImpl().load(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SharedProjectConfigFileRepository.set', () => {
  it('writes a Server entry that round-trips through load()', async () => {
    const dir = tempDir('write-server');
    try {
      const repo = new SharedProjectConfigRepositoryImpl();
      await repo.set(dir, {
        projectKey: 'onprem_key',
        path: 'services/onprem',
        serverUrl: 'https://sonarqube.internal',
      });

      expect(await repo.load(dir)).toEqual({
        projectRoot: canonicalizePath(join(dir, 'services/onprem')),
        projectKey: 'onprem_key',
        serverUrl: 'https://sonarqube.internal',
        organization: undefined,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a Cloud entry that round-trips through load()', async () => {
    const dir = tempDir('write-cloud');
    try {
      const repo = new SharedProjectConfigRepositoryImpl();
      await repo.set(dir, {
        projectKey: 'acme_us',
        path: '.',
        region: 'us',
        organization: 'acme',
      });

      expect(await repo.load(dir)).toEqual({
        projectRoot: canonicalizePath(join(dir, '.')),
        projectKey: 'acme_us',
        serverUrl: SONARCLOUD_US_URL,
        organization: 'acme',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('overwrites an existing entry rather than appending to it', async () => {
    const dir = tempDir('overwrite');
    try {
      const repo = new SharedProjectConfigRepositoryImpl();
      await repo.set(dir, { projectKey: 'first', path: '.', serverUrl: 'https://a.example' });
      await repo.set(dir, { projectKey: 'second', path: '.', serverUrl: 'https://b.example' });

      const mapping = await repo.load(dir);
      expect(mapping?.projectKey).toBe('second');
      expect(mapping?.serverUrl).toBe('https://b.example');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('nests the written entry under a "project" field, leaving room for future top-level fields', async () => {
    const dir = tempDir('write-shape');
    try {
      const repo = new SharedProjectConfigRepositoryImpl();
      await repo.set(dir, { projectKey: 'x', path: '.', serverUrl: 'https://sq.example' });

      const raw = JSON.parse(readFileSync(join(dir, SHARED_PROJECT_CONFIG_FILE_NAME), 'utf-8'));
      expect(raw).toEqual({
        project: { projectKey: 'x', path: '.', serverUrl: 'https://sq.example' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
