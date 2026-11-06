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

import {
  type Ecosystem,
  ECOSYSTEMS,
  type IntendedArchitecture,
  type IntendedGroup,
  type StructureGraph,
  type StructureNode,
} from './architecture-api.ts';
import { incompatibleResponse } from './errors.ts';

const MAX_PUBLIC_GROUPS = 50_000;
const MAX_PUBLIC_GROUP_DEPTH = 64;
export const MODEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidPublicModel(): never {
  throw incompatibleResponse(
    'Invalid public intended architecture response: invalid model field shape.',
  );
}

function objectField(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return invalidPublicModel();
  return value as Record<string, unknown>;
}

export function toIntended(value: unknown): IntendedArchitecture {
  const raw = objectField(value);
  const { qualifiers: type, language, groups, constraints } = raw;
  const label = raw.label ?? undefined;
  const description = raw.description ?? undefined;
  if (
    (type !== 'file' && type !== 'namespace') ||
    (label !== undefined && typeof label !== 'string') ||
    (description !== undefined && typeof description !== 'string') ||
    typeof language !== 'string' ||
    !(ECOSYSTEMS as readonly string[]).includes(language) ||
    !Array.isArray(groups) ||
    !Array.isArray(constraints)
  )
    return invalidPublicModel();
  const budget = { count: 0 };
  return {
    type,
    ...(label === undefined ? {} : { label }),
    ...(description === undefined ? {} : { description }),
    language: language as Ecosystem,
    groups: groups.map((group: unknown) => publicGroup(group, 0, budget)),
    constraints: constraints.map((value: unknown) => {
      const { from, to } = objectField(value);
      if (typeof from !== 'string' || typeof to !== 'string') return invalidPublicModel();
      return { from, to };
    }),
  };
}

function publicGroup(value: unknown, depth: number, budget: { count: number }): IntendedGroup {
  if (depth > MAX_PUBLIC_GROUP_DEPTH || ++budget.count > MAX_PUBLIC_GROUPS)
    return invalidPublicModel();
  const group = normalizeOptionalGroupFields(objectField(value));
  if (
    typeof group.label !== 'string' ||
    (group.description !== undefined && typeof group.description !== 'string') ||
    (group.patternId !== undefined &&
      (typeof group.patternId !== 'string' || !MODEL_ID.test(group.patternId))) ||
    (group.patterns !== undefined &&
      (!Array.isArray(group.patterns) ||
        group.patterns.some((pattern: unknown) => typeof pattern !== 'string'))) ||
    (group.groups !== undefined && !Array.isArray(group.groups)) ||
    (group.interface !== undefined && typeof group.interface !== 'boolean') ||
    (group.interfaceAccess !== undefined && typeof group.interfaceAccess !== 'boolean')
  )
    return invalidPublicModel();
  return {
    label: group.label,
    ...(group.description === undefined ? {} : { description: group.description }),
    ...(group.patternId === undefined ? {} : { patternId: group.patternId }),
    ...(group.patterns === undefined ? {} : { patterns: group.patterns as string[] }),
    ...(group.groups === undefined
      ? {}
      : {
          groups: (group.groups as unknown[]).map((child) => publicGroup(child, depth + 1, budget)),
        }),
    ...(group.interface === undefined ? {} : { interface: group.interface }),
    ...(group.interfaceAccess === undefined ? {} : { interfaceAccess: group.interfaceAccess }),
  };
}

function normalizeOptionalGroupFields(raw: Record<string, unknown>): Record<string, unknown> {
  const group = { ...raw };
  for (const field of [
    'description',
    'patternId',
    'patterns',
    'groups',
    'interface',
    'interfaceAccess',
  ]) {
    if (group[field] === null) group[field] = undefined;
  }
  return group;
}

function invalidPublicGraph(): never {
  throw incompatibleResponse(
    'Invalid public current architecture response: invalid graph field shape.',
  );
}

function graphObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return invalidPublicGraph();
  return value as Record<string, unknown>;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function publicGraph(value: unknown): StructureGraph {
  const graph = graphObject(value);
  if (!isInteger(graph.nodeCount) || !isInteger(graph.edgeCount) || !Array.isArray(graph.nodes))
    return invalidPublicGraph();
  const budget = { count: 0 };
  return {
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    nodes: graph.nodes.map((node: unknown) => publicNode(node, 0, budget)),
  };
}

function publicNode(value: unknown, depth: number, budget: { count: number }): StructureNode {
  if (depth > 256 || ++budget.count > 1_000_000) return invalidPublicGraph();
  const node = graphObject(value);
  if (
    !isInteger(node.id) ||
    typeof node.name !== 'string' ||
    typeof node.kind !== 'string' ||
    !Array.isArray(node.edges) ||
    (node.nodes !== undefined && !Array.isArray(node.nodes)) ||
    (node.separator !== undefined && typeof node.separator !== 'string')
  )
    return invalidPublicGraph();
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    edges: node.edges.map((value: unknown) => {
      const edge = graphObject(value);
      if (!isInteger(edge.toId) || !isInteger(edge.weight)) return invalidPublicGraph();
      return { toId: edge.toId, weight: edge.weight };
    }),
    ...(node.nodes === undefined
      ? {}
      : { nodes: (node.nodes as unknown[]).map((child) => publicNode(child, depth + 1, budget)) }),
    ...(node.separator === undefined ? {} : { separator: node.separator }),
  };
}
