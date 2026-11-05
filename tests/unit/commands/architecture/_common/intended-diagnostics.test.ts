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

import { describe, expect, it, mock } from 'bun:test';

import type {
  ArchitectureApi,
  IntendedArchitecture,
  StructureGraph,
} from '@/commands/architecture/_common/architecture-api.ts';
import { intendedDiagnostics } from '@/commands/architecture/_common/intended-diagnostics.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';

const graph: StructureGraph = {
  nodeCount: 5,
  edgeCount: 0,
  nodes: [
    {
      id: 1,
      name: 'gctoolkit-parser',
      kind: 'module',
      edges: [],
      nodes: [
        {
          id: 2,
          name: 'com.microsoft.gctoolkit.parser',
          kind: 'package',
          edges: [],
          nodes: [
            {
              id: 3,
              name: 'jvm',
              kind: 'package',
              edges: [],
              nodes: [{ id: 5, name: 'Parser', kind: 'class', edges: [] }],
            },
            { id: 4, name: 'unified', kind: 'package', edges: [] },
          ],
        },
      ],
    },
  ],
};
const model: IntendedArchitecture = {
  type: 'namespace',
  language: 'java',
  constraints: [],
  groups: [
    {
      label: 'gctoolkit-parser',
      patterns: ['gctoolkit-parser:**'],
      groups: [
        {
          label: 'com.microsoft.gctoolkit.parser.jvm',
          patterns: ['gctoolkit-parser:com.microsoft.gctoolkit.parser.jvm'],
        },
        {
          label: 'com.microsoft.gctoolkit.parser.unified',
          patterns: ['gctoolkit-parser:com.microsoft.gctoolkit.parser.unified'],
        },
      ],
    },
  ],
};
function api(current = graph): ArchitectureApi {
  const backend = {
    getCurrent: () => Promise.resolve([{ ecosystem: 'java' as const, graph: current }]),
    getIntended: () => Promise.resolve([]),
    getIntendedState: () => Promise.resolve({ models: [] }),
    createIntended: mock(async () => {}),
    updateIntended: mock(async () => {}),
    deleteIntended: mock(async () => {}),
  };
  return backend;
}
describe('intended discovery diagnostics', () => {
  it('reports the missing container wildcard and skipped physical parent without changing the model', async () => {
    const before = JSON.stringify(model);
    const backend = api();
    const warnings = await intendedDiagnostics(backend, [model]);
    expect(warnings.some((warning) => warning.includes('names a container'))).toBe(true);
    expect(warnings.filter((warning) => warning.includes('different parent'))).toHaveLength(2);
    expect(warnings.join(' ')).toContain('com.microsoft.gctoolkit.parser');
    expect(JSON.stringify(model)).toBe(before);
  });
  it('keeps exact leaf patterns, complete physical chains and logical models valid', async () => {
    const corrected = structuredClone(model);
    corrected.groups[0].groups = [
      {
        label: 'com.microsoft.gctoolkit.parser',
        patterns: ['gctoolkit-parser:com.microsoft.gctoolkit.parser.**'],
        groups: [
          { label: 'jvm', patterns: ['gctoolkit-parser:com.microsoft.gctoolkit.parser.jvm.**'] },
          {
            label: 'unified',
            patterns: ['gctoolkit-parser:com.microsoft.gctoolkit.parser.unified'],
          },
        ],
      },
    ];
    expect(await intendedDiagnostics(api(), [corrected])).toEqual([]);
    expect(
      await intendedDiagnostics(api(), [
        { ...model, groups: [{ label: 'Logical', patterns: ['future/**'] }] },
      ]),
    ).toEqual([]);
  });
  it('recognizes a missing glob after the separator', async () => {
    const warnings = await intendedDiagnostics(api(), [
      { ...model, groups: [{ label: 'parser', patterns: ['gctoolkit-parser:'] }] },
    ]);
    expect(warnings.join()).toContain('names a container');
  });
  it('leaves imported expansions to the server', async () => {
    const imported = structuredClone(model);
    imported.groups[0].patternId = '11111111-1111-4111-8111-111111111111';
    expect(await intendedDiagnostics(api(), [imported])).toEqual([]);
  });
  it('reports unavailable discovery without inventing missing patterns', async () => {
    const backend = api();
    backend.getCurrent = () => Promise.reject(new Error('unavailable'));
    expect((await intendedDiagnostics(backend, [model])).join()).toContain('checks unavailable');
    backend.getCurrent = () => Promise.resolve([]);
    expect((await intendedDiagnostics(backend, [model])).join()).toContain('checks unavailable');
  });
  it('keeps unavailable languages and counts warnings beyond the shared budget', async () => {
    const backend = api();
    backend.getCurrent = (language) =>
      language === 'java'
        ? Promise.resolve([{ ecosystem: 'java', graph }])
        : Promise.reject(
            new CommandFailedError('Invalid public current architecture response.', {
              remediationHint: 'Check the supported public Architecture API contract.',
            }),
          );
    const crowded: IntendedArchitecture = {
      ...model,
      groups: Array.from({ length: 13 }, (_, i) => ({
        label: `group${i}`,
        patterns: ['gctoolkit-parser'],
      })),
    };
    const warnings = await intendedDiagnostics(backend, [crowded, { ...model, language: 'ts' }]);
    expect(warnings[0]).toContain('ts: pattern and physical hierarchy checks unavailable');
    expect(warnings[0]).toContain('Invalid public current architecture response.');
    expect(warnings[0]).toContain('Check the supported public Architecture API contract.');
    expect(warnings.filter((warning) => warning.includes('names a container'))).toHaveLength(10);
    expect(warnings.at(-1)).toBe('3 additional discovery warning(s) omitted.');
    expect(warnings).toHaveLength(12);
  });
});
