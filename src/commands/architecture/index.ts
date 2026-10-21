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

// `sonar architecture get current|intended`

import { encode as encodeToToon } from '@toon-format/toon';

import {
  createArchitectureApi,
  type CurrentGraph,
  type Ecosystem,
} from '@/core/architecture/architecture-api.ts';
import { toArchitectureError } from '@/core/architecture/errors.ts';
import {
  DEFAULT_MAX_NODES,
  type GraphSlice,
  indexStructure,
  sliceGraph,
  topLevelKeys,
} from '@/core/architecture/graph.ts';
import { assertGroupExists, revisionOf, viewIntended } from '@/core/architecture/intended-model.ts';
import { shellQuote } from '@/core/architecture/shell-quote.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolveFormatOption } from '@/core/commands/params.ts';
import {
  assertSingleLineProjectKey,
  discoverProject,
} from '@/core/project-discovery/project-info.ts';

import { formatCurrentText, formatSliceLimit } from './current-text.ts';
import { formatIntendedText } from './intended-text.ts';

export const ARCHITECTURE_FORMATS = ['toon', 'json'] as const;
export type ArchitectureFormat = (typeof ARCHITECTURE_FORMATS)[number];
/** The read commands also have a text form, their default on a terminal. */
export const TEXT_FORMATS = ['text', ...ARCHITECTURE_FORMATS] as const;

const NO_ANALYSIS_HINT =
  'Run an analysis of a supported language (Java, C#, JavaScript, TypeScript or Python) first.';

export interface ArchitectureReadOptions {
  project?: string;
  component?: string;
  depth?: number;
  language?: Ecosystem;
  format?: string;
}

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
    ctx.console.warn(`No current architecture yet for '${projectKey}'. ${NO_ANALYSIS_HINT}`);
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

export function defaultTextFormat(): (typeof TEXT_FORMATS)[number] {
  return process.stdout.isTTY || process.env.SONARQUBE_CLI_MOCK_TTY ? 'text' : 'toon';
}

export async function getIntended(
  options: ArchitectureReadOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const depth = resolveDepth(options, Number.POSITIVE_INFINITY);
  const format = resolveFormatOption(options.format, TEXT_FORMATS, defaultTextFormat());
  const projectKey = await resolveProject(options, ctx);
  const all = await createArchitectureApi(ctx.connection, projectKey)
    .getIntended()
    .catch((error: unknown) => {
      throw toArchitectureError(error, projectKey);
    });
  // The revision covers every stored language, so set intended can check a filtered file too.
  const revision = revisionOf(all);
  const { language } = options;
  const models = language ? all.filter((model) => model.language === language) : all;

  if (models.length === 0) {
    ctx.console.warn(`No intended architecture yet for '${projectKey}'.`);
  }
  const partial = options.component !== undefined || options.depth !== undefined;
  if (options.component !== undefined) assertGroupExists(models, options.component);
  const views = models.flatMap((model) => viewIntended(model, options.component, depth) ?? []);
  if (format === 'text') {
    if (models.length > 0)
      ctx.console.print(formatIntendedText(projectKey, revision, models, views));
    return;
  }
  if (partial) {
    printPayload(ctx, format, { project: projectKey, revision, partial: true, models: views });
    return;
  }
  printPayload(ctx, format, {
    project: projectKey,
    revision,
    ...(language ? { language } : {}),
    models,
  });
}

function resolveDepth(options: ArchitectureReadOptions, defaultDepth: number): number {
  if (options.depth === undefined) return defaultDepth;
  if (!Number.isInteger(options.depth) || options.depth < 1) {
    throw new InvalidOptionError(
      `Invalid --depth option: '${options.depth}'. Must be an integer >= 1`,
    );
  }
  return options.depth;
}

export async function resolveProject(
  options: { project?: string },
  ctx: CommandAuthenticatedInvocationContext,
): Promise<string> {
  const projectKey =
    options.project ??
    (
      await discoverProject(process.cwd(), {
        auth: ctx.auth,
        useGitRemoteBinding: false,
        silent: true,
        console: ctx.console,
      })
    ).projectKey;
  if (!projectKey) {
    throw new CommandFailedError('Could not determine project key.', {
      remediationHint:
        "Use --project <key>, run from inside a linked project directory, or run 'sonar link <projectKey>' to link this repository.",
    });
  }
  assertSingleLineProjectKey(projectKey);
  ctx.console.print(
    `     Using ${options.project ? '' : 'auto-detected '}project key: ${projectKey}`,
    'stderr',
  );
  return projectKey;
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
      `sonar architecture get current --project ${shellQuote(projectKey)}${language} --component ${shellQuote(key)}`,
  );
}

function describeSlice(current: CurrentGraph, slice: GraphSlice): Record<string, unknown> {
  const where = slice.root ? `below '${slice.root}'` : 'from the top level';
  const cap = slice.capped ? ` ${formatSliceLimit(slice)}` : '';
  const edgeCap =
    slice.omittedEdges > 0
      ? ` Showing the ${slice.edges.length} heaviest of ${slice.edges.length + slice.omittedEdges} dependencies.`
      : '';
  return {
    language: current.ecosystem,
    summary: `Showing ${slice.nodes.length} of ${slice.totalNodes} nodes, ${slice.depth} level(s) ${where}.${cap}${edgeCap}`,
    ...slice,
  };
}

function printPayload(
  ctx: CommandAuthenticatedInvocationContext,
  format: ArchitectureFormat,
  payload: Record<string, unknown>,
): void {
  ctx.console.print(format === 'json' ? JSON.stringify(payload, null, 2) : encodeToToon(payload));
}
