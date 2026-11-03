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

import { CommandFailedError } from '@/core/commands/command-error.ts';

import { type Ecosystem, ECOSYSTEMS } from './architecture-api.ts';

const MAX_DIRECTIVE_ENUM_LENGTH = 30;
const MAX_DIRECTIVE_PERSPECTIVE_LENGTH = 255;
const DIRECTIVE_UUID_LENGTH = 36;
export const DEFAULT_DIRECTIVES_PAGE_SIZE = 50;
export const DEFAULT_DIRECTIVE_PERSPECTIVE = 'default_perspective';

export class DirectiveNotFoundError extends CommandFailedError {}

export const DIRECTIVE_TYPES = ['REMOVE_EDGE', 'RENAME_NODE', 'MOVE_NODE'] as const;
export interface DirectiveInput {
  type: (typeof DIRECTIVE_TYPES)[number];
  ecosystem: Ecosystem;
  graphType: 'file_graph' | 'namespace_graph';
  fromNodeKey: string;
  toNodeKey: string;
  graphPerspective?: string;
  description?: string;
}
export interface ProjectDirective extends DirectiveInput {
  origin?: string;
  id: string;
  projectId: string;
}
export interface DirectivePage {
  directives: ProjectDirective[];
  page: { pageIndex: number; pageSize: number; total: number };
}
export interface DirectivesApi {
  getDirectivesPage(pageIndex: number, pageSize: number): Promise<DirectivePage>;
  getDirective(id: string): Promise<ProjectDirective>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CommandFailedError('Each directive must be an object.');
  return value as Record<string, unknown>;
}
function stringField(value: Record<string, unknown>, name: string, max: number): string {
  const field = value[name];
  if (typeof field !== 'string' || !field.trim() || field.length > max)
    throw new CommandFailedError(
      `Directive ${name} must be a nonempty string of at most ${max} characters.`,
    );
  return field;
}
function inputFieldLimit(name: string, max: number, inputFields?: Set<string>): number {
  return inputFields && !inputFields.has(name) ? Infinity : max;
}

export function parseDirective(value: unknown, inputFields?: Set<string>): DirectiveInput {
  const object = record(value);
  const type = stringField(object, 'type', MAX_DIRECTIVE_ENUM_LENGTH);
  const ecosystem = stringField(object, 'ecosystem', 10);
  const graphType = stringField(object, 'graphType', MAX_DIRECTIVE_ENUM_LENGTH);
  if (!(DIRECTIVE_TYPES as readonly string[]).includes(type))
    throw new CommandFailedError('Directive type must be REMOVE_EDGE, RENAME_NODE or MOVE_NODE.');
  if (!(ECOSYSTEMS as readonly string[]).includes(ecosystem))
    throw new CommandFailedError('Unsupported directive ecosystem.');
  if (graphType !== 'file_graph' && graphType !== 'namespace_graph')
    throw new CommandFailedError('Directive graphType must be file_graph or namespace_graph.');
  const directive: DirectiveInput = {
    type: type as DirectiveInput['type'],
    ecosystem: ecosystem as Ecosystem,
    graphType,
    fromNodeKey: stringField(
      object,
      'fromNodeKey',
      inputFieldLimit('fromNodeKey', 1000, inputFields),
    ),
    toNodeKey: stringField(object, 'toNodeKey', inputFieldLimit('toNodeKey', 1000, inputFields)),
  };
  for (const [name, max] of [
    ['graphPerspective', MAX_DIRECTIVE_PERSPECTIVE_LENGTH],
    ['description', 10000],
  ] as const) {
    const field = object[name];
    if (field !== undefined && field !== null) {
      if (typeof field !== 'string' || field.length > inputFieldLimit(name, max, inputFields))
        throw new CommandFailedError(
          `Directive ${name} must be a string of at most ${max} characters.`,
        );
      directive[name] = field;
    }
  }
  return directive;
}
export function parseProjectDirective(value: unknown): ProjectDirective {
  const object = record(value);
  const id = stringField(object, 'id', DIRECTIVE_UUID_LENGTH);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new CommandFailedError('Public directive response has an invalid id.');
  if (object.origin != null && typeof object.origin !== 'string')
    throw new CommandFailedError('Public directive origin must be a string.');
  return {
    ...parseDirective(object, new Set()),
    id,
    projectId: stringField(object, 'projectId', 1000),
    ...(object.origin == null ? {} : { origin: object.origin }),
  };
}

export function directiveId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    throw new CommandFailedError('Directive id must be a UUID. Nothing was changed.');
  return value.toLowerCase();
}
