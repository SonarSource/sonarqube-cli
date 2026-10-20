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

// Human-readable `sonar architecture get current --format text`.

import type { GraphSlice } from '@/core/architecture/graph.ts';
import { bold, cyan, dim } from '@/core/ui/colors.ts';

const MAX_TEXT_EDGES = 20;
const MAX_GROUP_NAMES = 10;

export interface CurrentTextView {
  language: string;
  slice: GraphSlice;
  groups: string[];
  drillDown: string[];
}

export function formatCurrentText(projectKey: string, views: CurrentTextView[]): string {
  return views.map((view) => formatView(projectKey, view)).join('\n\n');
}

function formatView(projectKey: string, { language, slice, groups, drillDown }: CurrentTextView) {
  const endpoints = [
    ...slice.edges.flatMap(({ from, to }) => [from, to]),
    ...slice.feedbackPairs.heaviest.flatMap(({ from, to }) => [from, to]),
  ];
  const { labels, base } = relativeLabels(uniqueLabels([...new Set([...groups, ...endpoints])]));
  const label = (key: string) => labels.get(key) ?? key;

  const names = groups.slice(0, MAX_GROUP_NAMES).map(label);
  if (groups.length > names.length) names.push(`… ${groups.length - names.length} more`);
  const where = slice.root ? `below ${slice.root}` : 'from the top level';
  const cap = slice.capped ? `, capped at ${slice.nodes.length} nodes` : '';
  const lines = [
    bold(
      `${projectKey} (${language}): ${groups.length} top-level group(s): ${names.join(', ')} — ` +
        `${slice.nodes.length} of ${slice.totalNodes} node(s) in view, ${slice.depth} level(s) ${where}${cap}`,
    ),
  ];
  if (base !== undefined) lines.push(dim(`Names are relative to ${base}`));

  lines.push(...formatDependencies(slice, label), ...formatFeedbackPairs(slice, label));

  if (slice.outsideViewWeight > 0) {
    lines.push(dim(`plus ${slice.outsideViewWeight} units to nodes outside this view`));
  }

  if (drillDown.length > 0) {
    lines.push('Drill down:', ...drillDown.map((command) => `  ${cyan(command)}`));
  }
  return lines.join('\n');
}

function formatDependencies(slice: GraphSlice, label: (key: string) => string): string[] {
  const totalEdges = slice.edges.length + slice.omittedEdges;
  const shownEdges = slice.edges.slice(0, MAX_TEXT_EDGES);
  let suffix = totalEdges ? ':' : '';
  if (totalEdges > shownEdges.length) suffix = `, heaviest ${shownEdges.length}:`;
  const lines = [`${totalEdges} dependenc${totalEdges === 1 ? 'y' : 'ies'}${suffix}`];
  for (const { from, to, weight } of shownEdges) {
    lines.push(`  ${label(from)} -> ${label(to)}  (${weight})`);
  }
  if (totalEdges > shownEdges.length) lines.push(`  … ${totalEdges - shownEdges.length} more`);
  return lines;
}

function formatFeedbackPairs(slice: GraphSlice, label: (key: string) => string): string[] {
  const { total, heaviest } = slice.feedbackPairs;
  if (total <= 0) return [];
  const suffix = total > heaviest.length ? `, heaviest ${heaviest.length}` : '';
  const lines = [`${total} feedback pair(s)${suffix}:`];
  for (const { from, to, weight } of heaviest) {
    lines.push(`  ${label(from)} <-> ${label(to)}  (${weight})`);
  }
  if (total > heaviest.length) lines.push(`  … ${total - heaviest.length} more pair(s)`);
  return lines;
}

const NAME_SEPARATORS = new Set(['.', '/']);

/**
 * Drops the package or folder every label of the view sits in, `com.example.parser.Trace` showing
 * as `Trace`, when at least two labels sit below it and the labels stay unique. The base itself
 * keeps its full label.
 */
export function relativeLabels(labels: Map<string, string>): {
  labels: Map<string, string>;
  base?: string;
} {
  const values = [...new Set(labels.values())];
  const base = commonBase(values);
  if (base === undefined) return { labels };
  const shortened = new Map(
    [...labels].map(([key, label]) => [key, label === base ? label : label.slice(base.length + 1)]),
  );
  if (new Set(shortened.values()).size !== values.length) return { labels };
  return { labels: shortened, base };
}

function commonBase(values: string[]): string | undefined {
  if (values.length === 0) return undefined;
  const first = values[0];
  for (let end = first.length; end > 0; end--) {
    if (end < first.length && !NAME_SEPARATORS.has(first.charAt(end))) continue;
    const base = first.slice(0, end);
    const below = values.filter(
      (value) => value.startsWith(base) && NAME_SEPARATORS.has(value.charAt(end)),
    ).length;
    const atBase = values.filter((value) => value === base).length;
    if (below >= 2 && below + atBase === values.length) return base;
  }
  return undefined;
}

/**
 * The shortest right-hand part of each key, in whole `:` segments, that no other key in
 * the view ends with: `maven-core:org.apache.maven.artifact` stays qualified only when
 * another module shows the same package.
 */
export function uniqueLabels(keys: string[]): Map<string, string> {
  const segmented = keys.map((key) => key.split(':'));
  const suffix = (segments: string[], n: number) => segments.slice(-n).join(':');
  const labels = new Map<string, string>();
  for (const segments of segmented) {
    const key = segments.join(':');
    let label = key;
    for (let n = 1; n < segments.length; n++) {
      const candidate = suffix(segments, n);
      const hits = segmented.filter((o) => o.length >= n && suffix(o, n) === candidate).length;
      if (hits === 1) {
        label = candidate;
        break;
      }
    }
    labels.set(key, label);
  }
  return labels;
}
