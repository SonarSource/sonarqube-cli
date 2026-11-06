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

// Integration tests for the intended architecture source: SonarQube, or a file in the repository

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { IntendedArchitecture } from '@/commands/architecture/_common/architecture-api.ts';

import type { RecordedRequest } from '../../harness';
import { type FakeSonarQubeServer, TestHarness } from '../../harness';
import { git, initGitRepo } from '../hook/git-test-helpers.ts';

const TOKEN = 'arch-token';
const PROJECT = 'shop';
const LOCATION_KEY = 'sonar.architecture.model.location';
const ARCHITECTURE_FILE = 'sonar-architecture.json';

const SAVED: IntendedArchitecture[] = [
  {
    type: 'namespace',
    language: 'java',
    groups: [
      { label: 'Domain', patterns: ['core:**'] },
      { label: 'Web', patterns: ['app:**'] },
    ],
    constraints: [{ from: 'Web', to: 'Domain' }],
  },
];

const NEXT: IntendedArchitecture[] = [
  { ...SAVED[0], constraints: [{ from: 'Domain', to: 'Web' }] },
];

interface SourceRead {
  project: string;
  revision?: string;
  source: { type: string; setting: string; file?: string; branch?: string };
  models: unknown[];
}

function architectureCalls(server: FakeSonarQubeServer): RecordedRequest[] {
  return server.getRecordedRequests().filter(({ path }) => path.startsWith('/architecture/'));
}

function writes(server: FakeSonarQubeServer): RecordedRequest[] {
  return architectureCalls(server).filter(({ method }) => method !== 'GET');
}

describe('sonar architecture intended source', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function start(setting?: string): Promise<FakeSonarQubeServer> {
    const builder = harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken(TOKEN)
      .withProject(PROJECT, (p) => p.withArchitecture((fake) => fake.withIntended(SAVED)));
    if (setting !== undefined) {
      builder.withProjectSettings(PROJECT, [{ key: LOCATION_KEY, value: setting }]);
    }
    const server = await builder.start();
    harness.withAuth(server.recordedAuthServerUrl(), TOKEN, 'my-org');
    return server;
  }

  async function linkCheckout(): Promise<void> {
    const linked = await harness.run(`link ${PROJECT}`);
    expect(linked.exitCode).toBe(0);
  }

  async function read(): Promise<SourceRead> {
    const result = await harness.run(
      `architecture intended get --project ${PROJECT} --format json`,
    );
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout) as SourceRead;
  }

  async function writeNext(revision: string | undefined, dryRun = false) {
    harness.cwd.writeFile('model.json', JSON.stringify({ revision, models: NEXT }));
    return harness.run(
      `architecture intended set --project ${PROJECT} --file model.json${dryRun ? ' --dry-run' : ''}`,
    );
  }

  it('reports the file and refuses writes when the setting is FILE', async () => {
    const server = await start('FILE');

    const get = await harness.run(`architecture intended get --project ${PROJECT} --format json`);
    expect(get.exitCode).toBe(0);
    expect(JSON.parse(get.stdout)).toEqual({
      project: PROJECT,
      source: { type: 'FILE', setting: 'FILE' },
      models: [],
    });
    expect(get.stderr).toContain("analyses don't use the model stored in SonarQube");
    expect(architectureCalls(server)).toEqual([]);

    for (const dryRun of [true, false]) {
      const set = await writeNext(undefined, dryRun);
      expect(set.exitCode).toBe(1);
      expect(set.stderr).toContain(
        `The intended architecture of '${PROJECT}' is managed by a file in its repository (the Architecture model location is FILE); nothing was changed.`,
      );
      expect(set.stderr).toContain(
        "Edit the sonar-architecture file in the project's repository and commit it",
      );
      expect(set.stderr).not.toContain('Add a sonar-architecture.json');
      expect(set.stderr).toContain('model location to SERVER');
    }
    expect(writes(server)).toEqual([]);
  });

  it('suggests adding a file only when the project checkout has no architecture file', async () => {
    const server = await start('FILE');
    await linkCheckout();
    const set = await writeNext(undefined);
    expect(set.exitCode).toBe(1);
    expect(set.stderr).toContain(
      'Add a sonar-architecture.json file to the repository and commit it',
    );
    expect(writes(server)).toEqual([]);
  });

  it('reports the file of the checkout and refuses writes when the setting is DYNAMIC', async () => {
    const server = await start('DYNAMIC');
    await linkCheckout();
    harness.cwd.writeFile(ARCHITECTURE_FILE, '{"perspectives":[]}');

    const text = await harness.run(`architecture intended get --project ${PROJECT} --format text`);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain(
      `The intended architecture of '${PROJECT}' is managed by ${ARCHITECTURE_FILE} in its repository`,
    );
    expect((await read()).source).toEqual({
      type: 'FILE',
      setting: 'DYNAMIC',
      file: ARCHITECTURE_FILE,
    });

    const set = await writeNext(undefined);
    expect(set.exitCode).toBe(1);
    expect(set.stderr).toContain(`managed by ${ARCHITECTURE_FILE} in its repository`);
    expect(set.stderr).toContain(`Edit ${ARCHITECTURE_FILE} and commit it`);
    expect(writes(server)).toEqual([]);
  });

  it('names the git branch of the checkout that holds the file', async () => {
    await start('DYNAMIC');
    initGitRepo(harness.cwd.path);
    git(['checkout', '-b', 'model-change'], harness.cwd.path);
    await linkCheckout();
    harness.cwd.writeFile(ARCHITECTURE_FILE, '{"perspectives":[]}');

    expect((await read()).source).toEqual({
      type: 'FILE',
      setting: 'DYNAMIC',
      file: ARCHITECTURE_FILE,
      branch: 'model-change',
    });
  });

  it('reads and writes the SonarQube model of a checkout without a file', async () => {
    const server = await start();
    await linkCheckout();

    const saved = await read();
    expect(saved.source).toEqual({ type: 'SERVER', setting: 'DYNAMIC' });
    expect(saved.models).toHaveLength(1);

    const set = await writeNext(saved.revision);
    expect(set.exitCode).toBe(0);
    expect(set.stderr).not.toContain('not a checkout');
    expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
  });

  it('writes the SonarQube model when the setting is SERVER, even with a file', async () => {
    const server = await start('SERVER');
    await linkCheckout();
    harness.cwd.writeFile(ARCHITECTURE_FILE, '{"perspectives":[]}');

    const saved = await read();
    expect(saved.source).toEqual({ type: 'SERVER', setting: 'SERVER' });

    const set = await writeNext(saved.revision);
    expect(set.exitCode).toBe(0);
    expect(set.stderr).not.toContain('not a checkout');
    expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
  });

  it('warns that a file may take precedence when run outside a checkout', async () => {
    const server = await start('DYNAMIC');

    const saved = await read();
    expect(saved.source).toEqual({ type: 'SERVER', setting: 'DYNAMIC' });

    const set = await writeNext(saved.revision);
    expect(set.exitCode).toBe(0);
    expect(set.stderr).toContain(`This directory is not a checkout of '${PROJECT}'.`);
    expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
  });
});
