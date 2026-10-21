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

// Validate the public request shape and client-side write safety before sending a model.

import { CommandFailedError } from '@/core/commands/command-error.ts';

import {
  type Ecosystem,
  ECOSYSTEMS,
  type IntendedArchitecture,
  type IntendedConstraint,
  type IntendedGroup,
} from './architecture-api.ts';
import { GROUP_KEY_SEPARATOR } from './intended-model.ts';

const MAX_GROUP_DEPTH = 64;
const MAX_GROUPS = 50_000;
const MAX_REPORTED_PROBLEMS = 10;
const FULL_EXPORT_HINT =
  'Export again without --component or --depth: sonar architecture intended get --format json.';
export const VALID_MODEL_RULES =
  'Each model requires type (file or namespace), a supported language, groups and constraints arrays. ' +
  'Groups require a label; optional patterns contain strings. Constraints require from and to strings. ' +
  'Sibling group labels must be unique and duplicate constraints are rejected by this client.';

/** A model file, as `intended get --format json` writes it, or a bare array of models. */
export interface IntendedFile {
  models: IntendedArchitecture[];
  /** The revision the file was read at; absent from a hand-written file. */
  revision?: string;
  /** Set when the file was read with --language: it replaces only that language's model. */
  language?: Ecosystem;
}

interface GroupContext {
  language: Ecosystem;
  keys: Set<string>;
  count: number;
  problems: string[];
}

/**
 * Parses and validates a model file. Every problem is collected so that one run reports
 * them all; the file is refused when there is any.
 */
export function parseIntendedFile(raw: unknown): IntendedFile {
  const file = Array.isArray(raw) ? { models: raw as unknown } : raw;
  if (!isObject(file) || !Array.isArray(file.models)) {
    throw invalidModel(['The file must hold "models": an array of intended architectures.']);
  }
  if (isPartialView(file)) {
    throw partialViewError();
  }
  const problems: string[] = [];
  if (
    file.revision !== undefined &&
    (typeof file.revision !== 'string' || file.revision.trim() === '')
  ) {
    problems.push('"revision" must be a nonblank string when supplied.');
  }
  const scope = file.language;
  if (scope !== undefined && (typeof scope !== 'string' || !isEcosystem(scope))) {
    problems.push(`"language" must be one of ${ECOSYSTEMS.join(', ')}.`);
  }
  const perspectives = new Set<string>();
  const models = (file.models as unknown[]).flatMap((value, index) => {
    const model = parseModel(value, `models[${index}]`, problems);
    if (!model) return [];
    const perspective = `${model.language}:${model.type}`;
    if (perspectives.has(perspective)) {
      problems.push(`More than one model for perspective ${perspective}.`);
    }
    perspectives.add(perspective);
    if (typeof scope === 'string' && model.language !== scope) {
      problems.push(
        `The file holds only the ${scope} model (intended get --language ${scope}), but models[${index}] is ${model.language}.`,
      );
    }
    return [model];
  });
  if (problems.length > 0) throw invalidModel(problems);
  return {
    models,
    revision: typeof file.revision === 'string' ? file.revision : undefined,
    ...(typeof scope === 'string' && isEcosystem(scope) ? { language: scope } : {}),
  };
}

function parseModel(
  value: unknown,
  where: string,
  problems: string[],
): IntendedArchitecture | undefined {
  if (!isObject(value)) {
    problems.push(`${where} must be an object.`);
    return undefined;
  }
  if (isPartialView(value)) {
    throw partialViewError();
  }
  const { language } = value;
  if (typeof language !== 'string' || !isEcosystem(language)) {
    problems.push(`${where}.language must be one of ${ECOSYSTEMS.join(', ')}.`);
    return undefined;
  }
  const type = value.type;
  if (type !== 'file' && type !== 'namespace') {
    problems.push(`${where}.type must be "file" or "namespace".`);
    return undefined;
  }
  const context: GroupContext = {
    language,
    keys: new Set(),
    count: 0,
    problems,
  };
  if (!Array.isArray(value.groups)) problems.push(`${where}.groups must be an array.`);
  if (!Array.isArray(value.constraints)) problems.push(`${where}.constraints must be an array.`);
  const groups = parseGroups(value.groups, [], 0, context);
  const constraints = parseConstraints(value.constraints, context);
  const metadata: Pick<IntendedArchitecture, 'label' | 'description'> = {};
  for (const field of ['label', 'description'] as const) {
    if (value[field] != null) {
      if (typeof value[field] !== 'string') problems.push(`${where}.${field} must be a string.`);
      else metadata[field] = value[field];
    }
  }
  return { type, language, groups, constraints, ...metadata };
}

function parseGroups(
  value: unknown,
  parent: string[],
  depth: number,
  context: GroupContext,
): IntendedGroup[] {
  if (value == null) return [];
  const { problems, language } = context;
  const owner = parent.join(GROUP_KEY_SEPARATOR) || `the ${language} model`;
  if (!Array.isArray(value)) {
    problems.push(`Groups of ${owner} must be an array.`);
    return [];
  }
  if (depth > MAX_GROUP_DEPTH) {
    problems.push(`The ${language} model is deeper than ${MAX_GROUP_DEPTH} levels.`);
    return [];
  }
  return value.flatMap((raw: unknown): IntendedGroup[] => {
    context.count++;
    if (context.count === MAX_GROUPS + 1) {
      problems.push(`The ${language} model has more than ${MAX_GROUPS} groups.`);
    }
    if (!isObject(raw) || typeof raw.label !== 'string' || raw.label.trim() === '') {
      problems.push(`Every group of ${owner} needs a label.`);
      return [];
    }
    if (raw.hiddenSubgroups !== undefined && raw.hiddenSubgroups !== null) {
      throw partialViewError();
    }
    const path = [...parent, raw.label];
    const key = path.join(GROUP_KEY_SEPARATOR);
    const identity = JSON.stringify(path);
    const name = `Group "${key}" (${language})`;
    if (context.keys.has(identity)) problems.push(`${name} is defined twice.`);
    context.keys.add(identity);

    const patterns = parsePatterns(raw.patterns, name, problems);
    const group: IntendedGroup = {
      label: raw.label,
      patterns,
      ...parseGroupMetadata(raw, name, problems),
    };
    for (const flag of ['interface', 'interfaceAccess'] as const) {
      const flagValue = raw[flag];
      if (typeof flagValue === 'boolean') group[flag] = flagValue;
      else if (flagValue != null) {
        problems.push(`${name}.${flag} must be true or false.`);
      }
    }
    const subgroups = parseGroups(raw.groups, path, depth + 1, context);
    if (raw.groups != null) group.groups = subgroups;
    return [group];
  });
}

function parseGroupMetadata(
  raw: Record<string, unknown>,
  name: string,
  problems: string[],
): Pick<IntendedGroup, 'description' | 'patternId'> {
  const metadata: Pick<IntendedGroup, 'description' | 'patternId'> = {};
  if (raw.description != null) {
    if (typeof raw.description !== 'string') problems.push(`${name}.description must be a string.`);
    else metadata.description = raw.description;
  }
  if (raw.patternId != null) {
    if (
      typeof raw.patternId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.patternId)
    )
      problems.push(`${name}.patternId must be a UUID.`);
    else metadata.patternId = raw.patternId;
  }
  return metadata;
}

function parsePatterns(value: unknown, name: string, problems: string[]): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((pattern) => typeof pattern !== 'string')) {
    problems.push(`${name} needs "patterns": an array of strings.`);
    return [];
  }
  const patterns = value as string[];
  return patterns;
}

function parseConstraints(value: unknown, context: GroupContext): IntendedConstraint[] {
  if (value == null) return [];
  const { problems, language } = context;
  if (!Array.isArray(value)) {
    problems.push(`Constraints of the ${language} model must be an array.`);
    return [];
  }
  const seen = new Set<string>();
  return value.flatMap((raw: unknown): IntendedConstraint[] => {
    if (!isObject(raw) || typeof raw.from !== 'string' || typeof raw.to !== 'string') {
      problems.push(`Every ${language} constraint needs "from" and "to" group keys.`);
      return [];
    }
    const { from, to } = raw;
    const pair = JSON.stringify([from, to]);
    if (seen.has(pair)) {
      problems.push(`The ${language} constraint ${from} -> ${to} is defined twice.`);
    }
    seen.add(pair);
    return [{ from, to }];
  });
}

function partialViewError(): CommandFailedError {
  return new CommandFailedError('The file is a partial view; nothing was changed.', {
    remediationHint: FULL_EXPORT_HINT,
  });
}

function invalidModel(problems: string[]): CommandFailedError {
  const listed = problems.slice(0, MAX_REPORTED_PROBLEMS);
  const more = problems.length - listed.length;
  return new CommandFailedError(
    [
      'The intended architecture is invalid; nothing was changed.',
      ...listed.map((problem) => `- ${problem}`),
      ...(more > 0 ? [`- …and ${more} more.`] : []),
    ].join('\n'),
    { remediationHint: VALID_MODEL_RULES },
  );
}

function isEcosystem(value: string): value is Ecosystem {
  return (ECOSYSTEMS as readonly string[]).includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPartialView(value: Record<string, unknown>): boolean {
  return (
    value.partial === true ||
    (value.component !== undefined && value.component !== null) ||
    (value.depth !== undefined && value.depth !== null)
  );
}
