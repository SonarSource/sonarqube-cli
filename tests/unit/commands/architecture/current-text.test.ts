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

import { describe, expect, it } from 'bun:test';

import {
  formatCurrentText as formatColored,
  relativeLabels,
  uniqueLabels,
} from '@/commands/architecture/current-text.ts';
import type { GraphSlice } from '@/core/architecture/graph.ts';
import { stripAnsi } from '@/core/ui/colors.ts';

const formatCurrentText: typeof formatColored = (...args) => stripAnsi(formatColored(...args));

function slice(overrides: Partial<GraphSlice>): GraphSlice {
  return {
    root: '',
    depth: 1,
    totalNodes: 10,
    nodes: [],
    edges: [],
    feedbackPairs: { total: 0, heaviest: [] },
    outsideViewWeight: 0,
    capped: false,
    omittedNodes: 0,
    omittedEdges: 0,
    drillDown: [],
    ...overrides,
  };
}

describe('uniqueLabels', () => {
  it('drops the module only where the rest of the key is unique in the view', () => {
    const labels = uniqueLabels(['core:a.b', 'compat:a.b', 'core:a.c', 'lib']);
    expect([...labels.values()]).toEqual(['core:a.b', 'compat:a.b', 'a.c', 'lib']);
  });
});

describe('relativeLabels', () => {
  it('drops the package every label sits in, keeping the package itself whole', () => {
    const { labels, base } = relativeLabels(
      uniqueLabels(['m:com.x.parser', 'm:com.x.parser.Trace', 'm:com.x.parser.io']),
    );
    expect(base).toBe('com.x.parser');
    expect([...labels.values()]).toEqual(['com.x.parser', 'Trace', 'io']);
  });

  it('works on folders and keeps labels that share no base', () => {
    expect(relativeLabels(uniqueLabels(['src/app', 'src/lib'])).base).toBe('src');
    const modules = relativeLabels(uniqueLabels(['core:a.b', 'compat:a.b', 'core:a.c']));
    expect(modules.base).toBeUndefined();
    expect([...modules.labels.values()]).toEqual(['core:a.b', 'compat:a.b', 'a.c']);
    expect(relativeLabels(uniqueLabels(['a.b'])).base).toBeUndefined();
  });
});

describe('formatCurrentText', () => {
  it('prints the header, dependencies, feedback, outside weight and one drill-down per line', () => {
    const text = formatCurrentText('p', [
      {
        language: 'java',
        slice: slice({
          nodes: ['app', 'core'].map((key) => ({
            key,
            kind: 'module',
            children: 1,
            descendants: 4,
            truncated: true,
          })),
          edges: [
            { from: 'app', to: 'core', weight: 5 },
            { from: 'core', to: 'app', weight: 2 },
          ],
          feedbackPairs: { total: 1, heaviest: [{ from: 'app', to: 'core', weight: 7 }] },
          outsideViewWeight: 3,
        }),
        groups: ['app', 'core'],
        drillDown: [
          'sonar architecture get current --project p --component app',
          'sonar architecture get current --project p --component core',
        ],
      },
    ]);
    expect(text).toBe(
      [
        'p (java): 2 top-level group(s): app, core — 2 of 10 node(s) in view, 1 level(s) from the top level',
        '2 dependencies:',
        '  app -> core  (5)',
        '  core -> app  (2)',
        '1 feedback pair(s):',
        '  app <-> core  (7)',
        'plus 3 units to nodes outside this view',
        'Drill down:',
        '  sonar architecture get current --project p --component app',
        '  sonar architecture get current --project p --component core',
      ].join('\n'),
    );
  });

  it('shows the heaviest 20 dependencies and 5 pairs, and counts the rest', () => {
    const edges = Array.from({ length: 22 }, (_, i) => ({
      from: `a${i}`,
      to: 'b',
      weight: 30 - i,
    }));
    const text = formatCurrentText('p', [
      {
        language: 'ts',
        slice: slice({
          root: 'src',
          capped: true,
          edges,
          omittedEdges: 3,
          feedbackPairs: { total: 8, heaviest: edges.slice(0, 5) },
        }),
        groups: [],
        drillDown: [],
      },
    ]);
    const lines = text.split('\n');
    expect(lines[0]).toBe(
      'p (ts): 0 top-level group(s):  — 0 of 10 node(s) in view, 1 level(s) below src, capped at 0 nodes',
    );
    expect(lines[1]).toBe('25 dependencies, heaviest 20:');
    expect(lines[22]).toBe('  … 5 more');
    expect(lines[23]).toBe('8 feedback pair(s), heaviest 5:');
    expect(lines.at(-1)).toBe('  … 3 more pair(s)');
  });

  it('says which package the shortened names are relative to', () => {
    const text = formatCurrentText('p', [
      {
        language: 'java',
        slice: slice({
          root: 'm',
          edges: [{ from: 'm:com.x.A', to: 'm:com.x.B', weight: 2 }],
        }),
        groups: ['m:com.x'],
        drillDown: [],
      },
    ]);
    expect(text.split('\n').slice(1)).toEqual([
      'Names are relative to com.x',
      '1 dependency:',
      '  A -> B  (2)',
    ]);
  });
});
