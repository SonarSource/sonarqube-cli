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

import { CommandFailedError } from '@/core/commands/command-error.ts';

import type { StructureGraph, StructureNode } from './architecture-api.ts';

export const DEFAULT_MAX_NODES = 150;
export const DEFAULT_MAX_EDGES = 2 * DEFAULT_MAX_NODES;
const MAX_DRILL_DOWN_HINTS = 5;
export const MAX_FEEDBACK_PAIRS = 5;

export interface IndexedGraph {
  key: Map<number, string>;
  kind: Map<number, string>;
  parent: Map<number, number>;
  children: Map<number, number[]>;
  /** Number of nodes below each node, at any depth. */
  descendants: Map<number, number>;
  idByKey: Map<string, number>;
  roots: number[];
  edges: Array<{ from: number; to: number; weight: number }>;
}

export interface SliceNode {
  key: string;
  kind: string;
  children: number;
  descendants: number;
  /** True when some of this node's children are not part of the slice. */
  truncated: boolean;
}

export interface SliceEdge {
  from: string;
  to: string;
  weight: number;
}

/** Visible nodes that depend on each other both ways, with the combined weight. */
export interface FeedbackPairs {
  total: number;
  /** The heaviest pairs, at most `MAX_FEEDBACK_PAIRS`; `from` is the heavier direction. */
  heaviest: SliceEdge[];
}

export interface GraphSlice {
  /** Node key the slice starts below, `''` for the top level. */
  root: string;
  depth: number;
  totalNodes: number;
  nodes: SliceNode[];
  /** The heaviest dependencies between visible nodes, at most `maxEdges`. */
  edges: SliceEdge[];
  /** Counted over every dependency between visible nodes, not only the `edges` shown. */
  feedbackPairs: FeedbackPairs;
  /** Weight of dependencies between a visible node and a node outside the slice. */
  outsideViewWeight: number;
  capped: boolean;
  omittedNodes: number;
  omittedEdges: number;
  /** Keys of the largest truncated nodes, worth a `--component` drill-down. */
  drillDown: string[];
}

/**
 * The separator a node's children are joined to it with, as SonarQube's architecture pages
 * build node keys: the node's own `separator`, or one inferred from its kind when the DTO
 * leaves it out (`module:package.Class`, `folder/file`).
 */
function childSeparator(node: StructureNode): string {
  if (node.separator) return node.separator;
  if (node.kind === 'module') return ':';
  if (node.kind === 'directory' || node.kind === 'folder') return '/';
  return '.';
}

export function indexStructure(graph: StructureGraph): IndexedGraph {
  const index: IndexedGraph = {
    key: new Map(),
    kind: new Map(),
    parent: new Map(),
    children: new Map(),
    descendants: new Map(),
    idByKey: new Map(),
    roots: graph.nodes.map(({ id }) => id),
    edges: [],
  };

  const walk = (node: StructureNode, key: string, parentId?: number): number => {
    index.key.set(node.id, key);
    index.kind.set(node.id, node.kind);
    index.idByKey.set(key, node.id);
    if (parentId !== undefined) index.parent.set(node.id, parentId);
    for (const edge of node.edges) {
      index.edges.push({ from: node.id, to: edge.toId, weight: edge.weight });
    }
    const separator = childSeparator(node);
    const children = node.nodes ?? [];
    index.children.set(
      node.id,
      children.map(({ id }) => id),
    );
    let descendants = 0;
    for (const child of children) {
      descendants += 1 + walk(child, `${key}${separator}${child.name}`, node.id);
    }
    index.descendants.set(node.id, descendants);
    return descendants;
  };

  for (const root of graph.nodes) walk(root, root.name);
  return index;
}

/**
 * The nodes `depth` levels below `component` (or below the top level), with their
 * dependencies rolled up to the visible nodes. Levels are added whole while they fit in
 * `maxNodes`; when even the first level does not fit, its largest nodes are kept.
 */
export function sliceGraph(
  graph: IndexedGraph,
  component: string | undefined,
  depth: number,
  maxNodes = DEFAULT_MAX_NODES,
  maxEdges = DEFAULT_MAX_EDGES,
): GraphSlice {
  const rootId = component === undefined ? undefined : graph.idByKey.get(component);
  if (component !== undefined && rootId === undefined) {
    throw new CommandFailedError(`No node '${component}' in the current architecture.`, {
      remediationHint:
        "Run 'sonar architecture get current' without --component to list the top-level node keys.",
    });
  }

  const visible: number[] = [];
  let frontier = rootId === undefined ? graph.roots : (graph.children.get(rootId) ?? []);
  let capped = false;
  for (let level = 1; level <= depth && frontier.length > 0; level++) {
    if (visible.length + frontier.length > maxNodes) {
      capped = true;
      if (visible.length === 0) visible.push(...largest(graph, frontier, maxNodes));
      break;
    }
    visible.push(...frontier);
    frontier = frontier.flatMap((id) => graph.children.get(id) ?? []);
  }

  const visibleSet = new Set(visible);
  const nodes = visible.map((id) => toSliceNode(graph, id, visibleSet));
  const below = rootId === undefined ? undefined : graph.descendants.get(rootId);
  const { edges, outsideViewWeight } = rollUpEdges(graph, visibleSet);
  const totalBelow =
    below ?? graph.roots.reduce((sum, id) => sum + 1 + descendantsOf(graph, id), 0);

  return {
    root: component ?? '',
    depth,
    totalNodes: totalBelow,
    nodes,
    edges: edges.slice(0, maxEdges),
    feedbackPairs: feedbackPairs(edges),
    outsideViewWeight,
    capped,
    omittedNodes: totalBelow - nodes.length,
    omittedEdges: Math.max(0, edges.length - maxEdges),
    drillDown: nodes
      .filter((node) => node.truncated)
      .sort((a, b) => b.descendants - a.descendants)
      .slice(0, MAX_DRILL_DOWN_HINTS)
      .map((node) => node.key),
  };
}

function descendantsOf(graph: IndexedGraph, id: number): number {
  return graph.descendants.get(id) ?? 0;
}

function largest(graph: IndexedGraph, ids: number[], count: number): number[] {
  return [...ids].sort((a, b) => descendantsOf(graph, b) - descendantsOf(graph, a)).slice(0, count);
}

function toSliceNode(graph: IndexedGraph, id: number, visible: Set<number>): SliceNode {
  const children = graph.children.get(id) ?? [];
  return {
    key: graph.key.get(id) ?? '',
    kind: graph.kind.get(id) ?? '',
    children: children.length,
    descendants: descendantsOf(graph, id),
    truncated: children.some((child) => !visible.has(child)),
  };
}

/** Keys of the slice nodes whose parent is not in the slice: the groups the slice is made of. */
export function topLevelKeys(graph: IndexedGraph, slice: GraphSlice): string[] {
  const shown = new Set(slice.nodes.map(({ key }) => key));
  return slice.nodes
    .filter(({ key }) => {
      const parent = graph.parent.get(graph.idByKey.get(key) ?? -1);
      return parent === undefined || !shown.has(graph.key.get(parent) ?? '');
    })
    .map(({ key }) => key);
}

/** Dependency cycles of length two, heaviest first; ties fall back to key order. */
export function feedbackPairs(edges: SliceEdge[]): FeedbackPairs {
  const weightOf = new Map(edges.map((edge) => [`${edge.from}\u0000${edge.to}`, edge.weight]));
  const pairs: SliceEdge[] = [];
  for (const { from, to, weight } of edges) {
    const back = weightOf.get(`${to}\u0000${from}`);
    if (back === undefined) continue;
    const heavier = weight > back || (weight === back && from < to);
    if (heavier) pairs.push({ from, to, weight: weight + back });
  }
  pairs.sort(
    (a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
  return { total: pairs.length, heaviest: pairs.slice(0, MAX_FEEDBACK_PAIRS) };
}

/**
 * Every dependency between two different visible nodes, attributed to the nearest visible
 * ancestor of each end, plus the weight of those with only one visible end.
 */
function rollUpEdges(
  graph: IndexedGraph,
  visible: Set<number>,
): { edges: SliceEdge[]; outsideViewWeight: number } {
  const nearestVisible = new Map<number, number | null>();
  const resolve = (id: number): number | null => {
    const cached = nearestVisible.get(id);
    if (cached !== undefined) return cached;
    const parent = graph.parent.get(id);
    let found: number | null = null;
    if (visible.has(id)) found = id;
    else if (parent !== undefined) found = resolve(parent);
    nearestVisible.set(id, found);
    return found;
  };

  const weights = new Map<string, SliceEdge>();
  let outsideViewWeight = 0;
  for (const edge of graph.edges) {
    const from = resolve(edge.from);
    const to = resolve(edge.to);
    if ((from === null) !== (to === null)) outsideViewWeight += edge.weight;
    if (from === null || to === null || from === to) continue;
    const fromKey = graph.key.get(from) ?? '';
    const toKey = graph.key.get(to) ?? '';
    const pair = `${fromKey}\u0000${toKey}`;
    const existing = weights.get(pair);
    if (existing) existing.weight += edge.weight;
    else weights.set(pair, { from: fromKey, to: toKey, weight: edge.weight });
  }
  return { edges: [...weights.values()].sort((a, b) => b.weight - a.weight), outsideViewWeight };
}
