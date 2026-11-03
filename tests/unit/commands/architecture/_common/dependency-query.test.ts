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

// Current-architecture graph: a key index over SonarQube's nested structure tree and a
// size-capped slice of it, so an agent explores a large project top-down.

// Cross-language ordering, malformed graph guards and content revisions are pure graph operations.
import { describe, expect, it } from 'bun:test';

import type {
  CurrentGraph,
  StructureNode,
} from '@/commands/architecture/_common/architecture-api.ts';
import {
  dependencySelection,
  queryDependencies,
} from '@/commands/architecture/_common/dependency-query.ts';

const node = (
  id: number,
  name: string,
  nodes: StructureNode[] = [],
  edges: Array<{ toId: number; weight: number }> = [],
): StructureNode => ({ id, name, kind: 'module', nodes, edges });
const graph = (
  nodes: StructureNode[],
  ecosystem: CurrentGraph['ecosystem'] = 'java',
): CurrentGraph => ({ ecosystem, graph: { nodes, nodeCount: 0, edgeCount: 0 } });
const selection = (pageIndex = 1, pageSize = 20) => ({
  from: 'compat',
  to: 'impl',
  pageIndex,
  pageSize,
});
const fixture = () =>
  graph([
    node(1, 'compat', [
      node(2, 'a', [
        node(3, 'A', [], [{ toId: 6, weight: 4 }]),
        node(4, 'B', [], [{ toId: 6, weight: 3 }]),
      ]),
    ]),
    node(5, 'impl', [node(6, 'C', [], [{ toId: 3, weight: 8 }])]),
  ]);

describe('targeted dependencies', () => {
  it('aggregates directed leaf edges at the requested frontier', () => {
    const result = queryDependencies([fixture()], selection(), 1);
    expect(result.dependencies).toEqual([{ from: 'compat:a', to: 'impl:C', weight: 7 }]);
    expect(result.page).toEqual({ pageIndex: 1, pageSize: 20, total: 1, hasNextPage: false });
    expect(
      queryDependencies([fixture()], { ...selection(), from: 'impl', to: 'compat' }, 1)
        .dependencies,
    ).toEqual([{ from: 'impl:C', to: 'compat:a', weight: 8 }]);
    expect(queryDependencies([fixture()], selection(), 2).dependencies).toHaveLength(2);
  });

  it('retains leaves when either endpoint has no children', () => {
    expect(
      queryDependencies([fixture()], { ...selection(), from: 'compat:a:A', to: 'impl:C' }, 9)
        .dependencies,
    ).toEqual([{ from: 'compat:a:A', to: 'impl:C', weight: 4 }]);
  });

  it('paginates all matches before the overview node and edge caps', () => {
    const nodes = [
      node(
        1,
        'compat',
        Array.from({ length: 160 }, (_, i) =>
          node(10 + i, `a${i}`, [], [{ toId: 200, weight: 1 }]),
        ),
      ),
      node(2, 'impl', [node(200, 'target')]),
    ];
    const pages = Array.from({ length: 8 }, (_, i) =>
      queryDependencies([graph(nodes)], selection(i + 1), 1),
    );
    expect(pages.every((page) => page.page.total === 160)).toBe(true);
    expect(new Set(pages.flatMap((page) => page.dependencies.map((edge) => edge.from))).size).toBe(
      160,
    );
    expect(new Set(pages.map((page) => page.revision)).size).toBe(1);
    expect(pages[7]?.page.hasNextPage).toBe(false);
    expect(queryDependencies([graph(nodes)], selection(2147483647), 1).dependencies).toEqual([]);
  });

  it('keeps revisions independent of page size and backend ordering, but detects changed content', () => {
    const first = fixture();
    const reordered = structuredClone(first);
    reordered.graph.nodes.reverse();
    const before = queryDependencies([first], selection(1, 1), 2);
    expect(queryDependencies([reordered], selection(2, 2), 2).revision).toBe(before.revision);
    reordered.graph.nodes[1].nodes![0].nodes![0].edges[0].weight++;
    expect(queryDependencies([reordered], selection(), 2).revision).not.toBe(before.revision);
  });

  it('handles overlap once and omits dependencies internal to one aggregate', () => {
    const result = queryDependencies(
      [fixture()],
      { ...selection(), from: 'compat', to: 'compat' },
      1,
    );
    expect(result.dependencies).toEqual([]);
    expect(
      queryDependencies([fixture()], { ...selection(), from: 'compat', to: 'compat:a' }, 2)
        .dependencies,
    ).toEqual([]);
  });

  it('omits ancestor-to-descendant aggregate rows while retaining deeper internal dependencies', () => {
    const nested = fixture();
    nested.graph.nodes[0].nodes![0].nodes![0].edges.push({ toId: 4, weight: 9 });
    const target = { ...selection(), to: 'compat:a' };
    expect(queryDependencies([nested], target, 1).dependencies).toEqual([]);
    expect(queryDependencies([nested], target, 2).dependencies).toEqual([
      { from: 'compat:a:A', to: 'compat:a:B', weight: 9 },
    ]);
    const reverse = { ...selection(), from: 'compat:a', to: 'compat' };
    expect(queryDependencies([nested], reverse, 1).dependencies).toEqual([]);
    expect(queryDependencies([nested], reverse, 2).dependencies).toEqual([
      { from: 'compat:a:A', to: 'compat:a:B', weight: 9 },
    ]);
  });

  it('does not index an unrelated malformed language graph', () => {
    const unrelated = graph([node(99, 'other'), node(99, 'unrelated')], 'py');
    expect(queryDependencies([unrelated, fixture()], selection(), 1).dependencies).toEqual([
      { from: 'compat:a', to: 'impl:C', weight: 7 },
    ]);
  });

  it('rejects ambiguity and never combines endpoints from different graphs', () => {
    expect(() =>
      queryDependencies([fixture(), { ...fixture(), ecosystem: 'ts' }], selection(), 1),
    ).toThrow('Specify --language');
    expect(() =>
      queryDependencies(
        [graph([node(1, 'compat')]), graph([node(2, 'impl')], 'ts')],
        selection(),
        1,
      ),
    ).toThrow('same current graph');
    expect(() => queryDependencies([], selection(), 1)).toThrow('same current graph');
  });

  it('rejects duplicate ids, keys, unresolved targets and duplicate edges', () => {
    expect(() =>
      queryDependencies([graph([node(1, 'compat'), node(1, 'impl')])], selection(), 1),
    ).toThrow('duplicate');
    expect(() =>
      queryDependencies(
        [graph([node(1, 'compat'), node(2, 'compat'), node(3, 'impl')])],
        selection(),
        1,
      ),
    ).toThrow('ambiguous');
    const broken = fixture();
    broken.graph.nodes[0].nodes![0].nodes![0].edges = [{ toId: 999, weight: 1 }];
    expect(() => queryDependencies([broken], selection(), 1)).toThrow('unresolved');
    const duplicate = fixture();
    const edges = duplicate.graph.nodes[0].nodes![0].nodes![0].edges;
    edges.push({ ...edges[0] });
    expect(() => queryDependencies([duplicate], selection(), 1)).toThrow('duplicate dependency');
  });

  it('refuses mixed container edges rather than double counting', () => {
    const mixed = fixture();
    mixed.graph.nodes[0].edges.push({ toId: 5, weight: 7 });
    expect(() => queryDependencies([mixed], selection(), 1)).toThrow('leaf-level');
  });

  it('rejects invalid and overflowing weights', () => {
    for (const weight of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = fixture();
      invalid.graph.nodes[0].nodes![0].nodes![0].edges[0].weight = weight;
      expect(() => queryDependencies([invalid], selection(), 1)).toThrow('weight');
    }
    const overflow = fixture();
    overflow.graph.nodes[0].nodes![0].nodes![0].edges[0].weight = Number.MAX_SAFE_INTEGER;
    expect(() => queryDependencies([overflow], selection(), 1)).toThrow('integer range');
  });

  it('uses UTF-16 ordering and canonical revision shared with Java', () => {
    const unicode = graph([
      node(1, 'compat', [
        node(3, '😀', [], [{ toId: 7, weight: 1 }]),
        node(4, '\ue000', [], [{ toId: 7, weight: 1 }]),
      ]),
      node(2, 'impl', [node(7, 'x')]),
    ]);
    const result = queryDependencies([unicode], selection(), 1);
    expect(result.dependencies.map((edge) => edge.from)).toEqual(['compat:😀', 'compat:\ue000']);
    expect(result.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it('validates targeted arguments without permitting pagination on an overview', () => {
    expect(dependencySelection({})).toBeUndefined();
    for (const options of [
      { from: 'compat' },
      { to: 'impl' },
      { page: 1 },
      { from: 'compat', to: 'impl', component: 'x' },
      ...[0, -1, 0.5, 2147483648].map((page) => ({ from: 'compat', to: 'impl', page })),
      ...[0, -1, 21, 1.5].map((pageSize) => ({ from: 'compat', to: 'impl', pageSize })),
    ]) {
      expect(() => dependencySelection(options)).toThrow();
    }
    expect(dependencySelection({ from: 'compat', to: 'impl' })).toEqual(selection());
  });
});
