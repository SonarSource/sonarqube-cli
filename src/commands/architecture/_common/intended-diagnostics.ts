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

import { remediationHintFor } from '@/core/commands/command-error.ts';

import type {
  ArchitectureApi,
  IntendedArchitecture,
  IntendedGroup,
  StructureNode,
} from './architecture-api.ts';
import { childSeparator, type IndexedGraph, indexStructure } from './graph.ts';

const MAX_WARNINGS = 10;

export async function intendedDiagnostics(
  api: ArchitectureApi,
  models: IntendedArchitecture[],
): Promise<string[]> {
  const warnings: DiscoveryWarnings = { shown: [], total: 0 };
  const unavailable: string[] = [];
  const languages = [
    ...new Set(models.filter((model) => model.groups.length > 0).map((model) => model.language)),
  ];
  await languages.reduce(
    (pending, language) =>
      pending.then(async () => {
        try {
          const graphs = await api.getCurrent(language);
          if (graphs.length !== 1) throw new Error('No unique discovery graph');
          const graph = indexStructure(graphs[0].graph);
          const artifacts = discoveryArtifacts(graphs[0].graph.nodes, graph);
          for (const model of models.filter((model) => model.language === language)) {
            inspectGroups(model.groups, graph, artifacts, warnings);
          }
        } catch (error) {
          const reason =
            error instanceof Error
              ? [error.message, remediationHintFor(error)].filter((part) => part?.trim()).join(' ')
              : '';
          const detail = reason ? ` (${reason})` : '';
          unavailable.push(
            `${language}: pattern and physical hierarchy checks unavailable; no complete discovery graph was read${detail}. Structural validation still applies.`,
          );
        }
      }),
    Promise.resolve(),
  );
  return [
    ...unavailable,
    ...warnings.shown,
    ...(warnings.total > warnings.shown.length
      ? [`${warnings.total - warnings.shown.length} additional discovery warning(s) omitted.`]
      : []),
  ];
}

function discoveryArtifacts(nodes: StructureNode[], graph: IndexedGraph): Map<string, number> {
  const artifacts = new Map<string, number>();
  const visit = (children: StructureNode[]): void => {
    for (const node of children) {
      const key = graph.key.get(node.id);
      if (key === undefined) throw new Error('Missing discovery key');
      artifacts.set(key, node.id);
      if ((node.nodes?.length ?? 0) > 0) {
        artifacts.set(`${key}${childSeparator(node)}`, node.id);
        artifacts.set(`${key}${childSeparator(node)}**`, node.id);
      }
      visit(node.nodes ?? []);
    }
  };
  visit(nodes);
  return artifacts;
}

interface DiscoveryWarnings {
  shown: string[];
  total: number;
}

function addWarning(warnings: DiscoveryWarnings, message: string): void {
  warnings.total++;
  if (warnings.shown.length < MAX_WARNINGS) warnings.shown.push(message);
}

function inspectGroups(
  groups: IntendedGroup[],
  graph: IndexedGraph,
  artifacts: Map<string, number>,
  warnings: DiscoveryWarnings,
  parentArtifact?: number,
): void {
  for (const group of groups) {
    if (group.patternId !== undefined) continue;
    const artifact = inspectPatterns(group, graph, artifacts, warnings);
    inspectParent(group, graph, warnings, artifact, parentArtifact);
    inspectGroups(group.groups ?? [], graph, artifacts, warnings, artifact);
  }
}

function inspectPatterns(
  group: IntendedGroup,
  graph: IndexedGraph,
  artifacts: Map<string, number>,
  warnings: DiscoveryWarnings,
): number | undefined {
  let artifact: number | undefined;
  for (const pattern of group.patterns ?? []) {
    const exact = artifacts.get(pattern);
    if (
      !pattern.endsWith('**') &&
      exact !== undefined &&
      (graph.children.get(exact)?.length ?? 0) > 0
    ) {
      addWarning(
        warnings,
        `Group "${group.label}": exact pattern "${pattern}" names a container, not its descendants. Use its discovery pattern with the child separator and ** if the subtree is intended; exact leaf patterns remain valid.`,
      );
    }
    artifact ??= exact;
  }
  return artifact;
}

function inspectParent(
  group: IntendedGroup,
  graph: IndexedGraph,
  warnings: DiscoveryWarnings,
  artifact?: number,
  parentArtifact?: number,
): void {
  if (
    artifact === undefined ||
    parentArtifact === undefined ||
    graph.parent.get(artifact) === parentArtifact
  )
    return;
  const actualParent = graph.key.get(graph.parent.get(artifact) ?? -1);
  if (actualParent !== undefined) {
    addWarning(
      warnings,
      `Group "${group.label}" is under a different parent from discovery ("${actualParent}"). For a physical hierarchy, retain intermediate parents; logical groupings are allowed. No groups were moved.`,
    );
  }
}
