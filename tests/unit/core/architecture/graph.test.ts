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

// Pure slicing logic, hard to cover exhaustively through the binary: key inference,
// level-wise capping and edge roll-up.

import { describe, expect, it } from 'bun:test';

import type { StructureGraph } from '@/core/architecture/architecture-api.ts';
import {
  feedbackPairs,
  indexStructure,
  sliceGraph,
  topLevelKeys,
} from '@/core/architecture/graph.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';

import { SYNTHETIC_GRAPH } from '../../../fixtures/architecture/synthetic-graph';

const GRAPH: StructureGraph = {
  id: 'g',
  nodeCount: 7,
  edgeCount: 3,
  nodes: [
    {
      id: 1,
      name: 'app',
      kind: 'module',
      edges: [],
      nodes: [
        {
          id: 2,
          name: 'com.example.web',
          kind: 'package',
          edges: [],
          nodes: [
            { id: 3, name: 'Controller', kind: 'class', edges: [{ toId: 6, weight: 2 }] },
            { id: 4, name: 'View', kind: 'class', edges: [{ toId: 3, weight: 1 }] },
          ],
        },
      ],
    },
    {
      id: 5,
      name: 'src',
      kind: 'directory',
      edges: [],
      nodes: [{ id: 6, name: 'index.ts', kind: 'file', edges: [{ toId: 7, weight: 5 }] }],
    },
    { id: 7, name: 'lib', kind: 'module', edges: [] },
  ],
};

describe('indexStructure', () => {
  it('joins children with a separator inferred from the parent kind', () => {
    const index = indexStructure(GRAPH);
    expect([...index.idByKey.keys()]).toEqual([
      'app',
      'app:com.example.web',
      'app:com.example.web.Controller',
      'app:com.example.web.View',
      'src',
      'src/index.ts',
      'lib',
    ]);
    expect(index.descendants.get(1)).toBe(3);
  });

  it("prefers the node's own separator over the one inferred from its kind", () => {
    const index = indexStructure({
      id: 'f',
      nodeCount: 3,
      edgeCount: 0,
      nodes: [
        {
          id: 1,
          name: 'web',
          kind: 'module',
          separator: '/',
          edges: [],
          nodes: [
            {
              id: 2,
              name: 'src',
              kind: 'directory',
              separator: '/',
              edges: [],
              nodes: [{ id: 3, name: 'app.ts', kind: 'file', separator: '/', edges: [] }],
            },
          ],
        },
      ],
    });
    expect([...index.idByKey.keys()]).toEqual(['web', 'web/src', 'web/src/app.ts']);
  });
});

describe('sliceGraph', () => {
  const index = indexStructure(GRAPH);

  it('shows the top level with dependencies rolled up and self-dependencies dropped', () => {
    const slice = sliceGraph(index, undefined, 1);
    expect(slice.nodes.map(({ key }) => key)).toEqual(['app', 'src', 'lib']);
    expect(slice.edges).toEqual([
      { from: 'src', to: 'lib', weight: 5 },
      { from: 'app', to: 'src', weight: 2 },
    ]);
    expect(slice).toMatchObject({ totalNodes: 7, capped: false, omittedNodes: 4, omittedEdges: 0 });
    expect(slice.drillDown).toEqual(['app', 'src']);
    expect(slice.feedbackPairs).toEqual({ total: 0, heaviest: [] });
    expect(slice.outsideViewWeight).toBe(0);
  });

  it('adds whole levels only while they fit, and stops before the one that does not', () => {
    const slice = sliceGraph(index, undefined, 3, 5);
    expect(slice.nodes.map(({ key }) => key)).toEqual([
      'app',
      'src',
      'lib',
      'app:com.example.web',
      'src/index.ts',
    ]);
    expect(slice.capped).toBe(true);
    expect(slice.drillDown).toEqual(['app:com.example.web']);
  });

  it('keeps the largest nodes when even the first level is over the cap', () => {
    const slice = sliceGraph(index, undefined, 1, 1);
    expect(slice.nodes.map(({ key }) => key)).toEqual(['app']);
    expect(slice).toMatchObject({ capped: true, omittedNodes: 6 });
  });

  it('starts below a component', () => {
    const slice = sliceGraph(index, 'app:com.example.web', 1);
    expect(slice.nodes.map(({ key }) => key)).toEqual([
      'app:com.example.web.Controller',
      'app:com.example.web.View',
    ]);
    expect(slice.edges).toEqual([
      {
        from: 'app:com.example.web.View',
        to: 'app:com.example.web.Controller',
        weight: 1,
      },
    ]);
    expect(slice.totalNodes).toBe(2);
    expect(slice.outsideViewWeight).toBe(2);
    expect(topLevelKeys(index, slice)).toEqual([
      'app:com.example.web.Controller',
      'app:com.example.web.View',
    ]);
  });

  it('counts dependencies to nodes left out by the cap as outside the view', () => {
    const slice = sliceGraph(index, undefined, 1, 1);
    expect(slice.outsideViewWeight).toBe(2);
  });

  it('names only the nodes without a visible parent as top-level groups', () => {
    const slice = sliceGraph(index, undefined, 2);
    expect(topLevelKeys(index, slice)).toEqual(['app', 'src', 'lib']);
  });

  it('keeps only the heaviest dependencies over the edge cap', () => {
    const slice = sliceGraph(index, undefined, 1, 150, 1);
    expect(slice.edges).toEqual([{ from: 'src', to: 'lib', weight: 5 }]);
    expect(slice.omittedEdges).toBe(1);
  });

  it('rejects an unknown component', () => {
    expect(() => sliceGraph(index, 'nope', 1)).toThrow(CommandFailedError);
  });
});

describe('feedbackPairs', () => {
  it('pairs mutual dependencies once, heaviest first, from the heavier direction', () => {
    expect(
      feedbackPairs([
        { from: 'a', to: 'b', weight: 1 },
        { from: 'b', to: 'a', weight: 4 },
        { from: 'c', to: 'd', weight: 3 },
        { from: 'd', to: 'c', weight: 3 },
        { from: 'a', to: 'c', weight: 9 },
      ]),
    ).toEqual({
      total: 2,
      heaviest: [
        { from: 'c', to: 'd', weight: 6 },
        { from: 'b', to: 'a', weight: 5 },
      ],
    });
  });

  it('keeps the heaviest five and counts the rest', () => {
    const edges = Array.from({ length: 7 }, (_, i) => [
      { from: `n${i}`, to: `m${i}`, weight: i + 1 },
      { from: `m${i}`, to: `n${i}`, weight: 1 },
    ]).flat();
    const pairs = feedbackPairs(edges);
    expect(pairs.total).toBe(7);
    expect(pairs.heaviest.map(({ from, weight }) => [from, weight])).toEqual([
      ['n6', 8],
      ['n5', 7],
      ['n4', 6],
      ['n3', 5],
      ['n2', 4],
    ]);
  });
});

describe('synthetic multi-module graph', () => {
  const index = indexStructure(SYNTHETIC_GRAPH[0]);

  it('has no feedback between the top-level modules', () => {
    const slice = sliceGraph(index, undefined, 1);
    expect(slice.feedbackPairs).toEqual({ total: 0, heaviest: [] });
    expect(slice.outsideViewWeight).toBe(0);
  });

  it('finds package cycles and the weight to other modules', () => {
    const slice = sliceGraph(index, 'module-00', 2);
    const pkg = (layer: number) => `module-00:com.example.synthetic.layer${layer}`;
    expect(slice.feedbackPairs).toEqual({
      total: 15,
      heaviest: [
        { from: pkg(0), to: pkg(1), weight: 148 },
        { from: pkg(0), to: pkg(2), weight: 146 },
        { from: pkg(0), to: pkg(3), weight: 144 },
        { from: pkg(0), to: pkg(4), weight: 142 },
        { from: pkg(0), to: pkg(5), weight: 140 },
      ],
    });
    expect(slice.outsideViewWeight).toBe(144);
  });
});
