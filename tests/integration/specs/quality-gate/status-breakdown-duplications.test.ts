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

// Integration tests for the duplications category breakdown in `quality-gate status`

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('quality-gate status — duplications breakdown', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'includes a duplications breakdown in JSON for a failing new_duplicated_lines_density condition',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          {
            key: 'new_duplicated_lines_density',
            type: 'PERCENT',
            name: 'Duplicated Lines (%) on New Code',
          },
        ])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'new_duplicated_lines_density',
                comparator: 'GT',
                errorThreshold: '3',
                actualValue: '10.6',
              },
            ])
            .withComponentTreeFiles('new_duplicated_lines_density', [
              { path: 'src/core/gitlab/client.ts', value: '10.6' },
              { path: 'src/checkout.ts', value: '4.2' },
            ])
            .withDuplications('src/core/gitlab/client.ts', { blockCount: 2 })
            .withDuplications('src/checkout.ts', {
              blockCount: 1,
              duplicatesWith: ['src/other.ts'],
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_duplicated_lines_density',
      );
      expect(condition.breakdown).toEqual({
        category: 'duplications',
        totalCount: 2,
        fetchedCount: 2,
        entries: [
          {
            path: 'src/core/gitlab/client.ts',
            value: '10.6',
            formattedValue: '10.6%',
            blockCount: 2,
            duplicatesWith: [],
          },
          {
            path: 'src/checkout.ts',
            value: '4.2',
            formattedValue: '4.2%',
            blockCount: 1,
            duplicatesWith: ['src/other.ts'],
          },
        ],
      });
    },
    { timeout: 15000 },
  );
  it(
    'includes a duplications breakdown in JSON for a failing overall duplicated_blocks condition, an INT metric',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'duplicated_blocks', type: 'INT', name: 'Duplicated Blocks' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'duplicated_blocks',
                comparator: 'GT',
                errorThreshold: '0',
                actualValue: '3',
              },
            ])
            .withComponentTreeFiles('duplicated_blocks', [
              { path: 'ecosystem-map.html', value: '2' },
              { path: 'index.html', value: '1' },
            ])
            .withDuplications('ecosystem-map.html', {
              blockCount: 2,
              duplicatesWith: ['index.html'],
            })
            .withDuplications('index.html', {
              blockCount: 1,
              duplicatesWith: ['ecosystem-map.html'],
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'duplicated_blocks',
      );
      expect(condition.breakdown).toEqual({
        category: 'duplications',
        totalCount: 2,
        fetchedCount: 2,
        entries: [
          // INT metric - no '%' suffix on formattedValue
          {
            path: 'ecosystem-map.html',
            value: '2',
            formattedValue: '2',
            blockCount: 2,
            duplicatesWith: ['index.html'],
          },
          {
            path: 'index.html',
            value: '1',
            formattedValue: '1',
            blockCount: 1,
            duplicatesWith: ['ecosystem-map.html'],
          },
        ],
      });
    },
    { timeout: 15000 },
  );
  it(
    'excludes a file with 0% duplication - it has nothing left to deduplicate',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          {
            key: 'new_duplicated_lines_density',
            type: 'PERCENT',
            name: 'Duplicated Lines (%) on New Code',
          },
        ])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'new_duplicated_lines_density',
                comparator: 'GT',
                errorThreshold: '3',
                actualValue: '10.6',
              },
            ])
            .withComponentTreeFiles('new_duplicated_lines_density', [
              { path: 'src/core/gitlab/client.ts', value: '10.6' },
              { path: 'src/clean.ts', value: '0.0' },
            ])
            .withDuplications('src/core/gitlab/client.ts', { blockCount: 2 }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_duplicated_lines_density',
      );
      expect(condition.breakdown).toEqual({
        category: 'duplications',
        totalCount: 1,
        fetchedCount: 1,
        entries: [
          {
            path: 'src/core/gitlab/client.ts',
            value: '10.6',
            formattedValue: '10.6%',
            blockCount: 2,
            duplicatesWith: [],
          },
        ],
      });
    },
    { timeout: 15000 },
  );
  it(
    'excludes a file with a duplicated_blocks count of 0, an INT metric',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'duplicated_blocks', type: 'INT', name: 'Duplicated Blocks' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'duplicated_blocks',
                comparator: 'GT',
                errorThreshold: '0',
                actualValue: '3',
              },
            ])
            .withComponentTreeFiles('duplicated_blocks', [
              { path: 'ecosystem-map.html', value: '2' },
              { path: 'clean.html', value: '0' },
            ])
            .withDuplications('ecosystem-map.html', { blockCount: 2 }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'duplicated_blocks',
      );
      expect(condition.breakdown).toEqual({
        category: 'duplications',
        totalCount: 1,
        fetchedCount: 1,
        entries: [
          {
            path: 'ecosystem-map.html',
            value: '2',
            formattedValue: '2',
            blockCount: 2,
            duplicatesWith: [],
          },
        ],
      });
    },
    { timeout: 15000 },
  );
  it(
    'renders the duplications breakdown in the table for a failing new-code duplications condition',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          {
            key: 'new_duplicated_lines_density',
            type: 'PERCENT',
            name: 'Duplicated Lines (%) on New Code',
          },
        ])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'new_duplicated_lines_density',
                comparator: 'GT',
                errorThreshold: '3',
                actualValue: '10.6',
              },
            ])
            .withComponentTreeFiles('new_duplicated_lines_density', [
              { path: 'src/core/gitlab/client.ts', value: '10.6' },
              { path: 'src/checkout.ts', value: '4.2' },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format table`);

      const lines = result.stdout.split('\n');
      const conditionIndex = lines.findIndex((l) => l.includes('Duplicated Lines'));
      expect(lines[conditionIndex + 1]).toContain('src/core/gitlab/client.ts');
      expect(lines[conditionIndex + 1]).toContain('10.6%');
      expect(lines[conditionIndex + 2]).toContain('src/checkout.ts');
      expect(lines[conditionIndex + 2]).toContain('4.2%');
    },
    { timeout: 15000 },
  );
  it(
    'renders block count and peer files as a suffix in the table',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          {
            key: 'new_duplicated_lines_density',
            type: 'PERCENT',
            name: 'Duplicated Lines (%) on New Code',
          },
        ])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'new_duplicated_lines_density',
                comparator: 'GT',
                errorThreshold: '3',
                actualValue: '10.6',
              },
            ])
            .withComponentTreeFiles('new_duplicated_lines_density', [
              { path: 'src/core/gitlab/client.ts', value: '10.6' },
              { path: 'src/checkout.ts', value: '4.2' },
            ])
            .withDuplications('src/core/gitlab/client.ts', { blockCount: 2 })
            .withDuplications('src/checkout.ts', {
              blockCount: 1,
              duplicatesWith: ['src/other.ts'],
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format table`);

      const lines = result.stdout.split('\n');
      const conditionIndex = lines.findIndex((l) => l.includes('Duplicated Lines'));
      expect(lines[conditionIndex + 1]).toContain('src/core/gitlab/client.ts (2 blocks)');
      expect(lines[conditionIndex + 2]).toContain('src/checkout.ts (1 block, dup: src/other.ts)');
    },
    { timeout: 15000 },
  );
  it(
    'includes the duplications breakdown when --category duplications is passed explicitly',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          {
            key: 'new_duplicated_lines_density',
            type: 'PERCENT',
            name: 'Duplicated Lines (%) on New Code',
          },
        ])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'new_duplicated_lines_density',
                comparator: 'GT',
                errorThreshold: '3',
                actualValue: '10.6',
              },
            ])
            .withComponentTreeFiles('new_duplicated_lines_density', [
              { path: 'src/core/gitlab/client.ts', value: '10.6' },
            ])
            .withDuplications('src/core/gitlab/client.ts', { blockCount: 2 }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status --project my-project --category duplications --format json`,
      );

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_duplicated_lines_density',
      );
      expect(condition.breakdown).toEqual({
        category: 'duplications',
        totalCount: 1,
        fetchedCount: 1,
        entries: [
          {
            path: 'src/core/gitlab/client.ts',
            value: '10.6',
            formattedValue: '10.6%',
            blockCount: 2,
            duplicatesWith: [],
          },
        ],
      });
    },
    { timeout: 15000 },
  );

  it(
    'keeps the file entry, without block/peer detail, when duplications/show fails for that file',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          {
            key: 'new_duplicated_lines_density',
            type: 'PERCENT',
            name: 'Duplicated Lines (%) on New Code',
          },
        ])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'new_duplicated_lines_density',
                comparator: 'GT',
                errorThreshold: '3',
                actualValue: '10.6',
              },
            ])
            .withComponentTreeFiles('new_duplicated_lines_density', [
              { path: 'src/core/gitlab/client.ts', value: '10.6' },
              { path: 'src/checkout.ts', value: '4.2' },
            ])
            .withDuplicationsError('src/core/gitlab/client.ts', 500)
            .withDuplications('src/checkout.ts', { blockCount: 1 }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_duplicated_lines_density',
      );
      expect(condition.breakdown).toEqual({
        category: 'duplications',
        totalCount: 2,
        fetchedCount: 2,
        entries: [
          // Failure degrades to no detail, not to dropping the entry
          { path: 'src/core/gitlab/client.ts', value: '10.6', formattedValue: '10.6%' },
          {
            path: 'src/checkout.ts',
            value: '4.2',
            formattedValue: '4.2%',
            blockCount: 1,
            duplicatesWith: [],
          },
        ],
      });
    },
    { timeout: 15000 },
  );
});
