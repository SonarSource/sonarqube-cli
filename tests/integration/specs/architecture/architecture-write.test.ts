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

// Integration tests for `sonar architecture intended set`

import { existsSync, readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { IntendedArchitecture } from '@/commands/architecture/_common/architecture-api.ts';
import { shellQuote } from '@/commands/architecture/_common/shell-quote.ts';
import { ALPHA_ENV_VAR } from '@/core/commands/stage.ts';

import { readTelemetryEvents } from '../../../_common/telemetry-helpers.ts';
import { type FakeSonarQubeServer, TestHarness } from '../../harness';
import { type FakeArchitecture } from '../../harness/fake-architecture';
import type { RecordedRequest } from '../../harness/types';

const TOKEN = 'arch-token';
const PROJECT = 'shop';

const SAVED: IntendedArchitecture[] = [
  {
    type: 'namespace',
    language: 'java',
    groups: [
      { label: 'Domain', patterns: ['core:com.shop.domain.**'] },
      { label: 'Legacy', patterns: ['core:com.shop.legacy.**'] },
      { label: 'Web', patterns: ['app:**'] },
    ],
    constraints: [
      { from: 'Web', to: 'Domain' },
      { from: 'Web', to: 'Legacy' },
    ],
  },
];

const NEXT: IntendedArchitecture[] = [
  {
    type: 'namespace',
    language: 'java',
    groups: [
      { label: 'Domain', patterns: ['core:com.shop.domain.**'], interface: true },
      { label: 'Web', patterns: ['app:**'] },
      { label: 'Billing', patterns: ['billing:**'] },
    ],
    constraints: [
      { from: 'Web', to: 'Domain' },
      { from: 'Billing', to: 'Domain' },
    ],
  },
];

const MODELS_PATH = '/architecture/intended-architectures';

function writes(server: FakeSonarQubeServer): RecordedRequest[] {
  return server
    .getRecordedRequests()
    .filter((request) => request.path.startsWith('/architecture/') && request.method !== 'GET');
}

describe('sonar architecture intended set', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.withExtraEnv({ [ALPHA_ENV_VAR]: 'true' });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function startWith(
    configure: (fake: FakeArchitecture) => void,
  ): Promise<FakeSonarQubeServer> {
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken(TOKEN)
      .withProject(PROJECT, (p) => p.withArchitecture(configure))
      .start();
    harness.withAuth(server.recordedAuthServerUrl(), TOKEN, 'my-org');
    return server;
  }

  function start(): Promise<FakeSonarQubeServer> {
    return startWith(() => undefined);
  }

  async function readSavedFile(): Promise<{ revision: string; models: IntendedArchitecture[] }> {
    const result = await harness.run(
      `architecture intended get --project ${PROJECT} --format json`,
    );
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout) as { revision: string; models: IntendedArchitecture[] };
  }

  function backupPathFrom(output: string): string {
    const match = /(?:backed up in|saved in|Backup kept at) ([^\r\n]+\.json)/.exec(output);
    expect(match).not.toBeNull();
    return match?.[1] ?? '';
  }

  describe('intended', () => {
    for (const direction of ['nest', 'flatten'] as const) {
      it(
        `applies a hierarchy change with a slash in a label (${direction})`,
        async () => {
          const flat: IntendedArchitecture = {
            type: 'namespace',
            language: 'java',
            groups: [
              { label: 'UI', patterns: [] },
              { label: 'UI/API', patterns: ['api.**'] },
            ],
            constraints: [],
          };
          const nested: IntendedArchitecture = {
            ...flat,
            groups: [
              { label: 'UI', patterns: [], groups: [{ label: 'API', patterns: ['api.**'] }] },
            ],
          };
          const original = [direction === 'nest' ? flat : nested];
          const next = [direction === 'nest' ? nested : flat];
          const server = await startWith((fake) => fake.withIntended(original));
          harness.cwd.writeFile(
            'model.json',
            JSON.stringify({ ...(await readSavedFile()), models: next }),
          );

          const dryRun = await harness.run(
            `architecture intended set --project ${PROJECT} --file model.json --dry-run`,
          );
          expect(dryRun.exitCode).toBe(0);
          const oldPath = direction === 'nest' ? ['UI/API'] : ['UI', 'API'];
          const newPath = direction === 'nest' ? ['UI', 'API'] : ['UI/API'];
          expect(dryRun.stdout).toContain(
            `  ~ group java UI/API: hierarchy ${JSON.stringify(oldPath)} -> ${JSON.stringify(newPath)}`,
          );
          expect(writes(server)).toEqual([]);

          const result = await harness.run(
            `architecture intended set --project ${PROJECT} --file model.json`,
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain(`Updated the intended architecture of '${PROJECT}'.`);
          expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
          const saved = await readSavedFile();
          expect(saved.models).toEqual(publicModels(next));

          harness.cwd.writeFile('model.json', JSON.stringify(saved));
          const unchanged = await harness.run(
            `architecture intended set --project ${PROJECT} --file model.json`,
          );
          expect(unchanged.exitCode).toBe(0);
          expect(unchanged.stdout).toContain('already matches the file; nothing was written.');
          expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
        },
        { timeout: 15000 },
      );
    }

    it('preserves the saved model without rollback when PATCH is refused', async () => {
      const server = await startWith((fake) => fake.withIntended(SAVED).failModelUpdate(1));
      harness.cwd.writeFile(
        'model.json',
        JSON.stringify({ ...(await readSavedFile()), models: NEXT }),
      );
      const result = await harness.run(
        `architecture intended set --project ${PROJECT} --file model.json`,
      );
      expect(result.exitCode).toBe(1);
      expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
      expect((await readSavedFile()).models).toEqual(publicModels(SAVED));
    });

    it('reports backup instructions when PATCH verification is unavailable', async () => {
      const server = await startWith((fake) =>
        fake
          .withIntended(SAVED)
          .failModelUpdate(1)
          .failIntendedRead(4)
          .failIntendedRead(5)
          .failIntendedRead(6)
          .failIntendedRead(7),
      );
      harness.cwd.writeFile(
        'model.json',
        JSON.stringify({ ...(await readSavedFile()), models: NEXT }),
      );
      const result = await harness.run(
        `architecture intended set --project ${PROJECT} --file model.json`,
      );
      expect(result.exitCode).toBe(1);
      const backup = backupPathFrom(result.stderr);
      expect(result.stderr).toContain(`--file ${shellQuote(backup)}`);
      expect(result.stderr).toContain('server state is unknown');
      expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
      expect((await readSavedFile()).models).toEqual(publicModels(SAVED));
    });

    it('includes top-level and nested sibling order in the dry run and applies it', async () => {
      const original: IntendedArchitecture[] = [
        {
          ...SAVED[0],
          groups: [
            {
              ...SAVED[0].groups[0],
              groups: [
                { label: 'A', patterns: ['a:**'] },
                { label: 'B', patterns: ['b:**'] },
              ],
            },
            ...SAVED[0].groups.slice(1),
          ],
        },
      ];
      const next: IntendedArchitecture[] = [
        {
          ...original[0],
          groups: [
            ...original[0].groups.slice(1),
            {
              ...original[0].groups[0],
              groups: [...(original[0].groups[0].groups ?? [])].reverse(),
            },
          ],
        },
      ];
      const server = await startWith((fake) => fake.withIntended(original));
      harness.cwd.writeFile(
        'model.json',
        JSON.stringify({ ...(await readSavedFile()), models: next }),
      );
      const dry = await harness.run(
        `architecture intended set --project ${PROJECT} --file model.json --dry-run`,
      );
      expect(dry.exitCode).toBe(0);
      expect(dry.stdout).toContain('group order java <root>:');
      expect(dry.stdout).toContain('group order java Domain: A, B -> B, A');
      expect(writes(server)).toEqual([]);
      const result = await harness.run(
        `architecture intended set --project ${PROJECT} --file model.json`,
      );
      expect(result.exitCode).toBe(0);
      expect((await readSavedFile()).models).toEqual(publicModels(next));
    });

    it(
      'dry run lists removals first and writes nothing',
      async () => {
        const server = await startWith((fake) => fake.withIntended(SAVED));
        const saved = await readSavedFile();
        harness.cwd.writeFile('model.json', JSON.stringify({ ...saved, models: NEXT }));

        const result = await harness.run(
          `architecture intended set --project ${PROJECT} --file model.json --dry-run`,
        );

        expect(result.exitCode).toBe(0);
        const lines = result.stdout.split('\n');
        const firstAdded = lines.findIndex((line) => line.startsWith('  + '));
        const lastRemoved = lines.map((line) => line.startsWith('  - ')).lastIndexOf(true);
        expect(lastRemoved).toBeLessThan(firstAdded);
        expect(result.stdout).toContain('  - group java Legacy');
        expect(result.stdout).toContain('  - constraint java Web -> Legacy');
        expect(result.stdout).toContain('  + group java Billing [billing:**]');
        expect(result.stdout).toContain('  + constraint java Billing -> Domain');
        expect(result.stdout).toContain('  ~ group java Domain: interface false -> true');
        expect(lines.at(-2)).toBe(
          '  ℹ  Dry run: nothing was written. Run without --dry-run to apply.',
        );
        expect(writes(server)).toEqual([]);
      },
      { timeout: 15000 },
    );

    it(
      'creates the model when the project has none, with no delete',
      async () => {
        const server = await start();
        harness.cwd.writeFile('model.json', JSON.stringify({ models: NEXT }));

        const result = await harness.run(
          `architecture intended set --project ${PROJECT} --file model.json`,
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`Created the intended architecture of '${PROJECT}'.`);
        expect(result.stderr).toContain('The file has no revision');
        const calls = writes(server);
        expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
          `POST ${MODELS_PATH}`,
        ]);
        expect(JSON.parse(calls[0].body ?? '{}')).toEqual({
          projectId: 'shop-branch-id',
          intendedArchitectures: NEXT.map(({ type, ...model }) => ({ qualifiers: type, ...model })),
        });
      },
      { timeout: 15000 },
    );

    it(
      'refuses an invalid model locally, before any request',
      async () => {
        const server = await startWith((fake) => fake.withIntended(SAVED));
        harness.cwd.writeFile(
          'model.json',
          JSON.stringify({
            models: [
              {
                type: 'namespace',
                language: 'java',
                groups: [
                  { label: 'Layer', patterns: 3, groups: [{ label: 'Jdbc', patterns: ['db:**'] }] },
                ],
                constraints: [{ from: 'Layer', to: 'Nowhere' }],
              },
            ],
          }),
        );

        const result = await harness.run(
          `architecture intended set --project ${PROJECT} --file model.json`,
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          'The intended architecture is invalid; nothing was changed.',
        );
        expect(result.stderr).toContain('Group "Layer" (java) needs "patterns"');
        expect(
          server.getRecordedRequests().filter(({ path }) => path.includes('/architecture/')),
        ).toEqual([]);
      },
      { timeout: 15000 },
    );

    it(
      'updates a saved model by backup and PATCH',
      async () => {
        const server = await startWith((fake) => fake.withIntended(SAVED));
        const saved = await readSavedFile();
        harness.cwd.writeFile('model.json', JSON.stringify({ ...saved, models: NEXT }));

        const result = await harness.run(
          `architecture intended set --project ${PROJECT} --file model.json`,
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`Updated the intended architecture of '${PROJECT}'.`);
        expect(writes(server).map(({ method, path }) => `${method} ${path}`)).toEqual([
          `PATCH ${MODELS_PATH}/00000000-0000-4000-8000-000000000001`,
        ]);
        const backup = backupPathFrom(result.stdout);
        expect(JSON.parse(readFileSync(backup, 'utf8'))).toEqual({
          project: PROJECT,
          models: publicModels(SAVED),
        });
        expect((await readSavedFile()).models).toEqual(publicModels(NEXT));
      },
      { timeout: 15000 },
    );

    it('keeps the original model and backup when PATCH is rejected', async () => {
      const server = await startWith((fake) =>
        fake.withIntended(SAVED).failModelUpdate(1, false, 400),
      );
      harness.cwd.writeFile(
        'model.json',
        JSON.stringify({ ...(await readSavedFile()), models: NEXT }),
      );
      const result = await harness.run(
        `architecture intended set --project ${PROJECT} --file model.json`,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Patch response failed (400)');
      expect(result.stderr).toContain('No automatic rollback was attempted');
      expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
      expect(existsSync(backupPathFrom(result.stderr))).toBe(true);
      expect((await readSavedFile()).models).toEqual(publicModels(SAVED));
    });

    it('prints a usable quoted restore command without automatically overwriting concurrent state', async () => {
      const server = await startWith((fake) =>
        fake.withIntended(SAVED).failModelUpdate(1).changeIntendedBeforeRead(4, NEXT),
      );
      harness.cwd.writeFile(
        'model.json',
        JSON.stringify({ ...(await readSavedFile()), models: NEXT }),
      );
      const result = await harness.run(
        `architecture intended set --project ${PROJECT} --file model.json`,
      );
      expect(result.exitCode).toBe(1);
      const backup = backupPathFrom(result.stderr);
      const command = `sonar architecture intended set --project ${PROJECT} --file ${shellQuote(backup)}`;
      expect(result.stderr).toContain(command);
      expect((await readSavedFile()).models).toEqual(publicModels(NEXT));
      expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
      const recovery = await harness.run(command.slice('sonar '.length));
      expect(recovery.exitCode).toBe(0);
      expect((await readSavedFile()).models).toEqual(publicModels(SAVED));
      expect(writes(server).map(({ method }) => method)).toEqual(['PATCH', 'PATCH']);
    });

    it(
      'refuses a file read from an older revision, with no write',
      async () => {
        const server = await startWith((fake) => fake.withIntended(SAVED));
        harness.cwd.writeFile(
          'model.json',
          JSON.stringify({ revision: 'f'.repeat(64), models: NEXT }),
        );

        const result = await harness.run(
          `architecture intended set --project ${PROJECT} --file model.json --dry-run`,
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('changed since the file was read; nothing was changed.');
        expect(writes(server)).toEqual([]);
      },
      { timeout: 15000 },
    );

    it(
      'refuses when the model changes between the first read and the PATCH',
      async () => {
        const server = await startWith((fake) =>
          // Read 1 is the test's own intended get, read 2 the set's first read.
          fake.withIntended(SAVED).changeIntendedBeforeRead(3, NEXT, true),
        );
        const saved = await readSavedFile();
        harness.cwd.writeFile('model.json', JSON.stringify({ ...saved, models: NEXT }));

        const result = await harness.run(
          `architecture intended set --project ${PROJECT} --file model.json`,
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('changed since the file was read');
        expect(writes(server)).toEqual([]);
      },
      { timeout: 15000 },
    );

    it(
      'changes a scoped language with PATCH while preserving the other language',
      async () => {
        const TS_MODEL: IntendedArchitecture = {
          type: 'file',
          language: 'ts',
          groups: [{ label: 'Ui', patterns: ['src/ui/**'] }],
          constraints: [],
        };
        const server = await startWith((fake) => fake.withIntended([...SAVED, TS_MODEL]));
        const read = await harness.run(
          `architecture intended get --project ${PROJECT} --language java --format json`,
        );
        const java = JSON.parse(read.stdout) as { revision: string; language: string };
        expect(java.language).toBe('java');
        harness.cwd.writeFile('model.json', JSON.stringify({ ...java, models: NEXT }));

        const dryRun = await harness.run(
          `architecture intended set --project ${PROJECT} --file model.json --dry-run`,
        );
        expect(dryRun.exitCode).toBe(0);
        expect(writes(server)).toEqual([]);
        const result = await harness.run(
          `architecture intended set --project ${PROJECT} --file model.json`,
        );
        expect(result.exitCode).toBe(0);
        expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
        expect((await readSavedFile()).models).toEqual(publicModels([TS_MODEL, ...NEXT]));
      },
      { timeout: 20000 },
    );

    it(
      'refuses a partial view read with --component or --depth, pointing to a full read',
      async () => {
        const server = await startWith((fake) => fake.withIntended(SAVED));
        const read = await harness.run(
          `architecture intended get --project ${PROJECT} --depth 1 --format json`,
        );
        harness.cwd.writeFile('model.json', read.stdout);

        const result = await harness.run(
          `architecture intended set --project ${PROJECT} --file model.json --dry-run`,
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          'Export again without --component or --depth: sonar architecture intended get --format json.',
        );
        expect(writes(server)).toEqual([]);
      },
      { timeout: 15000 },
    );

    it(
      'writes nothing when the file matches the saved model',
      async () => {
        const server = await startWith((fake) => fake.withIntended(SAVED));
        harness.cwd.writeFile('model.json', JSON.stringify(await readSavedFile()));

        const result = await harness.run(
          `architecture intended set --project ${PROJECT} --file model.json`,
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('already matches the file; nothing was written.');
        expect(writes(server)).toEqual([]);
      },
      { timeout: 15000 },
    );

    it(
      'relays a 403 with the permission and plan hint',
      async () => {
        await startWith((fake) =>
          fake.withStatus(
            'intended-architectures',
            403,
            JSON.stringify({ message: 'Missing architectureadmin' }),
            'POST',
          ),
        );
        harness.cwd.writeFile('model.json', JSON.stringify({ models: NEXT }));

        const result = await harness.run(
          `architecture intended set --project ${PROJECT} --file model.json`,
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('SonarQube refused the change: Missing architectureadmin');
        expect(result.stderr).toContain('Administer Architecture permission');
      },
      { timeout: 15000 },
    );

    it(
      'records CliArchitectureSet telemetry',
      async () => {
        const server = await startWith((fake) => fake.withIntended(SAVED));
        harness.state().withTelemetryEnabled();
        const saved = await readSavedFile();
        harness.cwd.writeFile('model.json', JSON.stringify({ ...saved, models: NEXT }));

        await harness.run(
          `architecture intended set --project ${PROJECT} --file model.json --dry-run`,
        );

        expect(
          server.getRecordedRequests().some(({ path }) => path === '/api/navigation/component'),
        ).toBe(false);
        const [event] = readTelemetryEvents(
          harness.sonarUserHome.path,
          'Analytics.Cli.CliArchitectureSet',
        );
        expect(event.event_payload).toMatchObject({
          target: 'intended',
          mode: 'dry-run',
          dry_run: true,
          removed: 2,
          added: 2,
          changed: 1,
        });
      },
      { timeout: 15000 },
    );
  });
});

function publicModels(models: IntendedArchitecture[]): IntendedArchitecture[] {
  function group(
    value: IntendedArchitecture['groups'][number],
  ): IntendedArchitecture['groups'][number] {
    return {
      ...value,
      groups: (value.groups ?? []).map(group),
      interface: value.interface ?? false,
      interfaceAccess: value.interfaceAccess ?? false,
    };
  }
  return models.map((model) => ({ ...model, groups: model.groups.map(group) }));
}
