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

import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolveFormatOption } from '@/core/commands/params.ts';

import { createArchitectureApi, type CurrentGraph } from '../../_common/architecture-api.ts';
import { toArchitectureError } from '../../_common/errors.ts';
import {
  DEFAULT_MAX_EDGES,
  DEFAULT_MAX_NODES,
  type GraphSlice,
  indexStructure,
  MAX_FEEDBACK_PAIRS,
  type SliceEdge,
  sliceGraph,
  topLevelKeys,
} from '../../_common/graph.ts';
import { resolveProject } from '../../_common/project.ts';
import {
  type ArchitectureReadOptions,
  defaultTextFormat,
  printPayload,
  resolveDepth,
  TEXT_FORMATS,
} from '../../_common/read-options.ts';
import { shellQuote } from '../../_common/shell-quote.ts';
import { formatCurrentText, formatSliceLimit } from './current-text.ts';

export async function getCurrent(
  options: ArchitectureReadOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const depth = resolveDepth(options, 1);
  const format = resolveFormatOption(options.format, TEXT_FORMATS, defaultTextFormat());
  const projectKey = await resolveProject(options, ctx);
  const graphs = await createArchitectureApi(ctx.connection, projectKey)
    .getCurrent(options.language)
    .catch((error: unknown) => {
      throw toArchitectureError(error, projectKey);
    });

  if (graphs.length === 0) {
    ctx.console.warn(
      `No current architecture was returned for '${projectKey}'. The response does not indicate whether analysis is missing or architecture data is unavailable.`,
    );
  }
  const indexed = graphs.map((current) => ({ current, index: indexStructure(current.graph) }));
  const { component } = options;
  const containing =
    component === undefined ? indexed : indexed.filter(({ index }) => index.idByKey.has(component));
  // When no language has the node, slicing the first one reports the unknown key.
  const shown = containing.length > 0 ? containing : indexed.slice(0, 1);
  const maxNodes = Math.max(1, Math.floor(DEFAULT_MAX_NODES / Math.max(1, shown.length)));
  let remainingNodes = DEFAULT_MAX_NODES;
  const views = shown.map(({ current, index }) => {
    const slice = sliceGraph(index, component, depth, Math.min(maxNodes, remainingNodes));
    remainingNodes -= slice.nodes.length;
    const drillDown = drillDownCommands(current, slice, projectKey, graphs.length > 1);
    return { current, index, slice, drillDown };
  });

  limitResponseEdges(views.map(({ slice }) => slice));

  if (format === 'text') {
    const text = views.map(({ current, index, slice, drillDown }) => ({
      language: current.ecosystem,
      slice,
      groups: topLevelKeys(index, slice),
      drillDown,
    }));
    if (text.length > 0) ctx.console.print(formatCurrentText(projectKey, text));
    return;
  }
  const languages = views.map(({ current, slice, drillDown }) => ({
    ...describeSlice(current, slice),
    drillDown: format === 'toon' ? drillDown.map((command) => ({ command })) : drillDown,
  }));
  printPayload(ctx, format, { project: projectKey, languages });
}

function drillDownCommands(
  current: CurrentGraph,
  slice: GraphSlice,
  projectKey: string,
  severalLanguages: boolean,
): string[] {
  const language = severalLanguages ? ` --language ${current.ecosystem}` : '';
  return slice.drillDown.map(
    (key) =>
      `sonar architecture current get --project ${shellQuote(projectKey)}${language} --component ${shellQuote(key)}`,
  );
}

function describeSlice(current: CurrentGraph, slice: GraphSlice): Record<string, unknown> {
  const where = slice.root ? `below '${slice.root}'` : 'from the top level';
  const cap = slice.capped ? ` ${formatSliceLimit(slice)}` : '';
  const edgeCap =
    slice.omittedEdges > 0
      ? slice.edges.length === 0
        ? ` No dependencies shown within the shared response budget; ${slice.omittedEdges} omitted.`
        : ` Showing the ${slice.edges.length} heaviest of ${slice.edges.length + slice.omittedEdges} dependencies.`
      : '';
  return {
    language: current.ecosystem,
    summary: `Showing ${slice.nodes.length} of ${slice.totalNodes} nodes, ${slice.depth} level(s) ${where}.${cap}${edgeCap}${slice.feedbackPairs.total > 0 && slice.feedbackPairs.heaviest.length === 0 ? ' No feedback pairs shown within the shared response budget.' : ''}`,
    ...slice,
  };
}

function limitResponseEdges(slices: GraphSlice[]): void {
  const edges = heaviestAcrossViews(
    slices.map((slice) => slice.edges),
    DEFAULT_MAX_EDGES,
  );
  const pairs = heaviestAcrossViews(
    slices.map((slice) => slice.feedbackPairs.heaviest),
    MAX_FEEDBACK_PAIRS,
  );
  for (const slice of slices) {
    const shown = slice.edges.filter((edge) => edges.has(edge));
    slice.omittedEdges += slice.edges.length - shown.length;
    slice.edges = shown;
    slice.feedbackPairs.heaviest = slice.feedbackPairs.heaviest.filter((pair) => pairs.has(pair));
  }
}

function heaviestAcrossViews(lists: SliceEdge[][], limit: number): Set<SliceEdge> {
  return new Set(
    lists
      .flatMap((entries, viewIndex) =>
        entries.map((entry, entryIndex) => ({ entry, viewIndex, entryIndex })),
      )
      .sort(
        (a, b) =>
          b.entry.weight - a.entry.weight ||
          a.viewIndex - b.viewIndex ||
          a.entryIndex - b.entryIndex,
      )
      .slice(0, limit)
      .map(({ entry }) => entry),
  );
}
