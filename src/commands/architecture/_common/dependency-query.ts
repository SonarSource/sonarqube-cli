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

import { createHash } from 'node:crypto';

import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';

import type { CurrentGraph } from './architecture-api.ts';
import { type IndexedGraph, indexStructure, type SliceEdge } from './graph.ts';
import type { ArchitectureReadOptions } from './read-options.ts';

export const DEPENDENCY_PAGE_SIZE = 20;

export function parseDependencyPageNumber(value: string): number {
  if (!/^[0-9]+$/.test(value))
    throw new InvalidOptionError('Dependency pagination requires whole decimal integers.');
  return Number(value);
}

export interface CurrentReadOptions extends ArchitectureReadOptions {
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface DependencySelection {
  from: string;
  to: string;
  pageIndex: number;
  pageSize: number;
}

export function dependencySelection(options: CurrentReadOptions): DependencySelection | undefined {
  const targeted = options.from !== undefined || options.to !== undefined;
  if (!targeted) {
    if (options.page !== undefined || options.pageSize !== undefined)
      throw new InvalidOptionError('Dependency pagination requires both --from and --to.');
    return undefined;
  }
  if (!options.from?.trim() || !options.to?.trim() || options.component !== undefined)
    throw new InvalidOptionError('Use both --from and --to, without --component.');
  const pageIndex = options.page ?? 1;
  const pageSize = options.pageSize ?? DEPENDENCY_PAGE_SIZE;
  if (
    !Number.isSafeInteger(pageIndex) ||
    pageIndex < 1 ||
    pageIndex > 2147483647 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > DEPENDENCY_PAGE_SIZE
  )
    throw new InvalidOptionError(
      'Page must be between 1 and 2147483647; dependency page size must be between 1 and 20.',
    );
  return { from: options.from, to: options.to, pageIndex, pageSize };
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : Number(left > right);
}

export interface DependencyPage {
  language: CurrentGraph['ecosystem'];
  from: string;
  to: string;
  depth: number;
  revision: string;
  dependencies: SliceEdge[];
  page: { pageIndex: number; pageSize: number; total: number; hasNextPage: boolean };
}

export function queryDependencies(
  graphs: CurrentGraph[],
  selection: DependencySelection,
  depth: number,
): DependencyPage {
  const indexed = graphs.map(({ ecosystem, graph }) => ({
    language: ecosystem,
    index: indexStructure(graph),
  }));
  const matching = indexed.filter(
    ({ index }) => index.idByKey.has(selection.from) && index.idByKey.has(selection.to),
  );
  if (matching.length !== 1)
    throw new CommandFailedError(
      matching.length > 1
        ? 'Dependency endpoints match more than one graph. Specify --language.'
        : 'Both dependency endpoints must exist in the same current graph. Check exact keys and language.',
    );
  const { language, index } = matching[0];
  const sources = representatives(index, selection.from, depth);
  const targets = representatives(index, selection.to, depth);
  const all = aggregateDependencies(index, sources, targets);
  const canonical = [
    'dependency-v1',
    language,
    selection.from,
    selection.to,
    String(depth),
    ...all.flatMap((edge) => [edge.from, edge.to, String(edge.weight)]),
  ]
    .map((value) => `${value.length}:${value}`)
    .join('');
  const start = (selection.pageIndex - 1) * selection.pageSize;
  return {
    language,
    from: selection.from,
    to: selection.to,
    depth,
    revision: createHash('sha256').update(canonical).digest('hex'),
    dependencies: all.slice(start, start + selection.pageSize),
    page: {
      pageIndex: selection.pageIndex,
      pageSize: selection.pageSize,
      total: all.length,
      hasNextPage: start + selection.pageSize < all.length,
    },
  };
}

function representatives(index: IndexedGraph, key: string, depth: number): Map<number, string> {
  const result = new Map<number, string>();
  const root = index.idByKey.get(key);
  if (root === undefined) throw new CommandFailedError('Unknown dependency endpoint.');
  const pending = [{ id: root, level: 0, representative: root }];
  while (pending.length) {
    const step = pending.pop();
    if (!step) break;
    const { id, level, representative } = step;
    result.set(id, index.key.get(representative) ?? key);
    for (const child of index.children.get(id) ?? []) {
      pending.push({
        id: child,
        level: level + 1,
        representative: level < depth ? child : representative,
      });
    }
  }
  return result;
}

function aggregateDependencies(
  index: IndexedGraph,
  sources: Map<number, string>,
  targets: Map<number, string>,
): SliceEdge[] {
  const weights = new Map<string, SliceEdge>();
  const seen = new Set<string>();
  for (const edge of index.edges) {
    if (!index.key.has(edge.to))
      throw new CommandFailedError('Current graph contains an unresolved dependency target.');
    const from = sources.get(edge.from);
    const to = targets.get(edge.to);
    if (from === undefined || to === undefined) continue;
    if (!Number.isSafeInteger(edge.weight) || edge.weight < 0)
      throw new CommandFailedError('Current graph contains an invalid dependency weight.');
    const identity = JSON.stringify([edge.from, edge.to]);
    if (seen.has(identity))
      throw new CommandFailedError('Current graph contains duplicate dependency edges.');
    seen.add(identity);
    if ((index.children.get(edge.from)?.length ?? 0) || (index.children.get(edge.to)?.length ?? 0))
      throw new CommandFailedError(
        'Targeted dependencies require leaf-level edges; this graph has container-level relationships in the selected scope.',
      );
    if (from === to) continue;
    const key = JSON.stringify([from, to]);
    const weight = (weights.get(key)?.weight ?? 0) + edge.weight;
    if (!Number.isSafeInteger(weight))
      throw new CommandFailedError(
        'Aggregated dependency weight exceeds the supported integer range.',
      );
    weights.set(key, { from, to, weight });
  }
  return [...weights.values()].sort(
    (a, b) => b.weight - a.weight || compareKeys(a.from, b.from) || compareKeys(a.to, b.to),
  );
}
