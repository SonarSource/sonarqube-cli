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
import {
  AccessDeniedError,
  BadRequestError,
  ForbiddenApiError,
  RateLimitError,
  RequestPayloadTooLargeError,
  UnexpectedApiError,
} from '@/core/server/errors.ts';

import { type Ecosystem, ECOSYSTEMS } from './architecture-api.ts';

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
  updateDirective(id: string, directive: DirectiveInput): Promise<ProjectDirective>;
  deleteDirective(id: string): Promise<void>;
  createDirective(directive: DirectiveInput): Promise<ProjectDirective>;
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
export function parseDirective(value: unknown): DirectiveInput {
  const object = record(value);
  const type = stringField(object, 'type', 30);
  const ecosystem = stringField(object, 'ecosystem', 10);
  const graphType = stringField(object, 'graphType', 30);
  if (!DIRECTIVE_TYPES.some((item) => item === type))
    throw new CommandFailedError('Directive type must be REMOVE_EDGE, RENAME_NODE or MOVE_NODE.');
  if (!ECOSYSTEMS.some((item) => item === ecosystem))
    throw new CommandFailedError('Unsupported directive ecosystem.');
  if (graphType !== 'file_graph' && graphType !== 'namespace_graph')
    throw new CommandFailedError('Directive graphType must be file_graph or namespace_graph.');
  const directive: DirectiveInput = {
    type: type as DirectiveInput['type'],
    ecosystem: ecosystem as Ecosystem,
    graphType,
    fromNodeKey: stringField(object, 'fromNodeKey', 1000),
    toNodeKey: stringField(object, 'toNodeKey', 1000),
  };
  for (const [name, max] of [
    ['graphPerspective', 255],
    ['description', 10000],
  ] as const) {
    const field = object[name];
    if (field !== undefined && field !== null) {
      if (typeof field !== 'string' || field.length > max)
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
  const id = stringField(object, 'id', 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new CommandFailedError('Public directive response has an invalid id.');
  if (object.origin != null && typeof object.origin !== 'string')
    throw new CommandFailedError('Public directive origin must be a string.');
  return {
    ...parseDirective(object),
    id,
    projectId: stringField(object, 'projectId', 1000),
    ...(object.origin == null ? {} : { origin: object.origin }),
  };
}
function parseCreates(items: unknown[]): DirectiveInput[] {
  return items.map((item) => {
    const object = record(item);
    const allowed = new Set([
      'id',
      'projectId',
      'type',
      'ecosystem',
      'graphType',
      'fromNodeKey',
      'toNodeKey',
      'graphPerspective',
      'description',
      'origin',
    ]);
    if (Object.keys(object).some((key) => !allowed.has(key)))
      throw new CommandFailedError(
        'A directive contains an unsupported field. Nothing was changed.',
      );
    for (const field of ['id', 'projectId', 'origin']) {
      if (object[field] != null && typeof object[field] !== 'string')
        throw new CommandFailedError(`Directive ${field} must be a string when supplied.`);
    }
    return parseDirective(object);
  });
}
export function directiveKey(directive: DirectiveInput): string {
  return JSON.stringify([
    directive.type,
    directive.ecosystem,
    directive.graphType,
    directive.fromNodeKey,
    directive.toNodeKey,
    directive.graphPerspective ?? '',
  ]);
}
export function isDefiniteRejection(error: unknown): boolean {
  return (
    error instanceof DirectiveNotFoundError ||
    error instanceof BadRequestError ||
    error instanceof ForbiddenApiError ||
    error instanceof AccessDeniedError ||
    error instanceof RateLimitError ||
    error instanceof RequestPayloadTooLargeError ||
    (error instanceof UnexpectedApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408)
  );
}

async function existingDirectiveKeys(api: DirectivesApi): Promise<Set<string>> {
  const keys = new Set<string>();
  const ids = new Set<string>();
  let total: number | undefined;
  for (let pageIndex = 1; ; pageIndex++) {
    const page = await api.getDirectivesPage(pageIndex, 100);
    total ??= page.page.total;
    if (page.page.total !== total || ids.size + page.directives.length > total)
      throw new CommandFailedError(
        'The public directives list changed while reading it. Read it again before changing directives.',
      );
    for (const directive of page.directives) {
      const id = directive.id.toLowerCase();
      if (ids.has(id))
        throw new CommandFailedError(
          'Inconsistent public directives pages; no complete list was read.',
        );
      ids.add(id);
      keys.add(directiveKey(directive));
    }
    if (ids.size === total) return keys;
    if (page.directives.length === 0)
      throw new CommandFailedError('Incomplete public directives pagination.');
  }
}

function planCreates(directives: DirectiveInput[], known: Set<string>) {
  const toCreate: DirectiveInput[] = [];
  let skipped = 0;
  for (const directive of directives) {
    const key = directiveKey(directive);
    if (known.has(key)) skipped++;
    else {
      known.add(key);
      toCreate.push(directive);
    }
  }
  return { toCreate, skipped };
}

export function directiveId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    throw new CommandFailedError('Directive id must be a UUID. Nothing was changed.');
  return value.toLowerCase();
}

export interface DirectiveUpdate {
  id: string;
  changes: Partial<DirectiveInput>;
}

function parseUpdates(items: unknown[]): DirectiveUpdate[] {
  const ids = new Set<string>();
  return items.map((item) => {
    const object = record(item);
    const id = directiveId(object.id);
    if (ids.has(id)) throw new CommandFailedError('Repeated directive id. Nothing was changed.');
    ids.add(id);
    const changes: Record<string, unknown> = {};
    const editable = [
      'type',
      'ecosystem',
      'graphType',
      'fromNodeKey',
      'toNodeKey',
      'graphPerspective',
      'description',
    ];
    for (const [key, field] of Object.entries(object)) {
      if (editable.includes(key)) {
        if (field === null)
          throw new CommandFailedError(
            'Directive fields cannot be cleared with null by the public API. Nothing was changed.',
          );
        changes[key] = field;
      } else if (!['id', 'projectId', 'origin'].includes(key))
        throw new CommandFailedError(
          'A directive contains an unsupported field. Nothing was changed.',
        );
    }
    return { id, changes };
  });
}

async function planUpdates(api: DirectivesApi, updates: DirectiveUpdate[]) {
  const changes: { id: string; before: ProjectDirective; after: DirectiveInput }[] = [];
  for (const update of updates) {
    const before = await api.getDirective(update.id);
    const after = parseDirective({ ...before, ...update.changes });
    if (directiveKey(before) !== directiveKey(after) || before.description !== after.description)
      changes.push({ id: update.id, before, after });
  }
  return { changes, skipped: updates.length - changes.length };
}

export interface DirectiveChanges {
  create: DirectiveInput[];
  update: DirectiveUpdate[];
  delete: string[];
}

export function parseDirectiveChanges(value: unknown, projectKey: string): DirectiveChanges {
  const object = record(value);
  if (
    Object.keys(object).some(
      (key) => !['create', 'update', 'delete', 'project', 'projectKey'].includes(key),
    )
  )
    throw new CommandFailedError(
      'Provide a change file with create, update and delete arrays. Nothing was changed.',
    );
  if (
    ['project', 'projectKey'].some((key) => object[key] !== undefined && object[key] !== projectKey)
  )
    throw new CommandFailedError(
      'The directive file belongs to a different project. Nothing was changed.',
    );
  const lists: Record<string, unknown[]> = {};
  for (const key of ['create', 'update', 'delete']) {
    const list = object[key] === undefined ? [] : object[key];
    if (!Array.isArray(list))
      throw new CommandFailedError(`Directive ${key} must be an array. Nothing was changed.`);
    lists[key] = list;
  }
  const create = lists.create.length ? parseCreates(lists.create) : [];
  const update = lists.update.length ? parseUpdates(lists.update) : [];
  const ids = new Set(update.map((item) => item.id));
  const deleted = lists.delete.map((item) => {
    const object = record(item);
    if (Object.keys(object).some((key) => key !== 'id'))
      throw new CommandFailedError('Delete accepts only {id} records. Nothing was changed.');
    const id = directiveId(object.id);
    if (ids.has(id))
      throw new CommandFailedError('Repeated or conflicting directive id. Nothing was changed.');
    ids.add(id);
    return id;
  });
  return { create, update, delete: deleted };
}

export async function applyDirectiveChanges(
  api: DirectivesApi,
  changes: DirectiveChanges,
  dryRun: boolean,
) {
  const updates = await planUpdates(api, changes.update);
  const toDelete: ProjectDirective[] = [];
  for (const id of changes.delete) toDelete.push(await api.getDirective(id));
  const moving = updates.changes.filter(
    (change) => directiveKey(change.before) !== directiveKey(change.after),
  );
  const known =
    changes.create.length || moving.length ? await existingDirectiveKeys(api) : new Set<string>();
  const afterKeys = new Set<string>();
  for (const change of moving) {
    const key = directiveKey(change.after);
    if (known.has(key) || afterKeys.has(key))
      throw new CommandFailedError(
        'An update would duplicate another directive. Nothing was changed.',
      );
    afterKeys.add(key);
  }
  const creations = planCreates(changes.create, known);
  const touchedKeys = new Set([
    ...updates.changes.flatMap((change) => [
      directiveKey(change.before),
      directiveKey(change.after),
    ]),
    ...toDelete.map(directiveKey),
  ]);
  if (changes.create.some((item) => touchedKeys.has(directiveKey(item))))
    throw new CommandFailedError(
      'Create conflicts with an update or deletion of the same directive operation. Nothing was changed.',
    );
  const result = {
    mode: dryRun ? 'dry-run' : 'applied',
    toCreate: creations.toCreate,
    changes: updates.changes,
    toDelete,
    skipped: creations.skipped + updates.skipped,
    created: [] as ProjectDirective[],
    updated: [] as ProjectDirective[],
    deleted: [] as string[],
  };
  if (dryRun) return result;
  let attempted = 'creation';
  let target = 'the current list';
  try {
    for (const directive of result.toCreate) {
      attempted = `create ${directive.type} ${directive.fromNodeKey} -> ${directive.toNodeKey}`;
      result.created.push(await api.createDirective(directive));
    }
    for (const change of result.changes) {
      attempted = `update ${change.id}`;
      target = `directive ${change.id}`;
      result.updated.push(await api.updateDirective(change.id, change.after));
    }
    for (const directive of result.toDelete) {
      attempted = `delete ${directive.id}`;
      target = `directive ${directive.id}`;
      await api.deleteDirective(directive.id);
      result.deleted.push(directive.id);
    }
  } catch (error) {
    const confirmed = result.created.length + result.updated.length + result.deleted.length;
    if (!confirmed && isDefiniteRejection(error)) throw error;
    throw new CommandFailedError(
      `Directive changes stopped after ${confirmed} confirmed writes. Created ids: ${result.created.map((item) => item.id).join(', ') || 'none confirmed'}. Updated ids: ${result.updated.map((item) => item.id).join(', ') || 'none'}. Deleted ids: ${result.deleted.join(', ') || 'none'}. ${isDefiniteRejection(error) ? 'The server rejected the next directive.' : 'The attempted change may already have been applied.'} Inspect ${target} before retrying. Attempted ${attempted}. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return result;
}
