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
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_REQUEST_TIMEOUT,
} from '@/core/server/http-constants.ts';

import { type Ecosystem, ECOSYSTEMS } from './architecture-api.ts';

const MAX_DIRECTIVE_ENUM_LENGTH = 30;
const MAX_DIRECTIVE_PERSPECTIVE_LENGTH = 255;
const DIRECTIVE_UUID_LENGTH = 36;
export const DEFAULT_DIRECTIVES_PAGE_SIZE = 50;
export const DEFAULT_DIRECTIVE_PERSPECTIVE = 'default_perspective';
const MAX_PROJECT_DIRECTIVES = 1000;

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
  createDirective(directive: DirectiveInput): Promise<ProjectDirective>;
}

function record(
  value: unknown,
  message = 'Each directive must be an object.',
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CommandFailedError(message);
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
    const directive = parseDirective(object);
    return {
      ...directive,
      graphPerspective: directive.graphPerspective ?? DEFAULT_DIRECTIVE_PERSPECTIVE,
    };
  });
}
export function directiveKey(directive: DirectiveInput): string {
  return JSON.stringify([
    directive.type,
    directive.ecosystem,
    directive.graphType,
    directive.fromNodeKey,
    directive.toNodeKey,
    directive.graphPerspective ?? DEFAULT_DIRECTIVE_PERSPECTIVE,
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
      error.status >= HTTP_STATUS_BAD_REQUEST &&
      error.status < HTTP_STATUS_INTERNAL_SERVER_ERROR &&
      error.status !== HTTP_STATUS_REQUEST_TIMEOUT)
  );
}

async function existingDirectives(api: DirectivesApi) {
  const keys = new Set<string>();
  const ids = new Set<string>();
  let total: number | undefined;
  for (let pageIndex = 1; ; pageIndex++) {
    const page = await api.getDirectivesPage(pageIndex, 100);
    if (
      page.directives.length !==
      Math.min(
        page.page.pageSize,
        Math.max(0, page.page.total - (pageIndex - 1) * page.page.pageSize),
      )
    )
      throw new CommandFailedError('Invalid public directives page; no complete page was read.');
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
    if (ids.size === total) return { keys, count: ids.size };
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
    const editable = new Set([
      'type',
      'ecosystem',
      'graphType',
      'fromNodeKey',
      'toNodeKey',
      'graphPerspective',
      'description',
    ]);
    for (const [key, field] of Object.entries(object)) {
      if (editable.has(key)) {
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
  const changes: {
    id: string;
    before: ProjectDirective;
    after: DirectiveInput;
    patch: DirectiveInput;
  }[] = [];
  await inSequence(updates, async (update) => {
    const before = await api.getDirective(update.id);
    const after = parseDirective(
      { ...before, ...update.changes },
      new Set(Object.keys(update.changes)),
    );
    if (directiveKey(before) !== directiveKey(after) || before.description !== after.description)
      changes.push({
        id: update.id,
        before,
        after,
        patch: {
          type: after.type,
          ecosystem: after.ecosystem,
          graphType: after.graphType,
          fromNodeKey: after.fromNodeKey,
          toNodeKey: after.toNodeKey,
          ...update.changes,
        },
      });
  });
  return { changes, skipped: updates.length - changes.length };
}

export interface DirectiveChanges {
  create: DirectiveInput[];
  update: DirectiveUpdate[];
}

export function parseDirectiveChanges(value: unknown, projectKey: string): DirectiveChanges {
  const object = record(
    value,
    'The directive change file must be a JSON object. Nothing was changed.',
  );
  if (
    Object.keys(object).some((key) => !['create', 'update', 'project', 'projectKey'].includes(key))
  )
    throw new CommandFailedError(
      'Provide a change file with create and update arrays. Nothing was changed.',
    );
  if (
    ['project', 'projectKey'].some((key) => object[key] !== undefined && object[key] !== projectKey)
  )
    throw new CommandFailedError(
      'The directive file belongs to a different project. Nothing was changed.',
    );
  const lists: Record<string, unknown[]> = {};
  for (const key of ['create', 'update']) {
    const list = object[key] === undefined ? [] : object[key];
    if (!Array.isArray(list))
      throw new CommandFailedError(`Directive ${key} must be an array. Nothing was changed.`);
    lists[key] = list;
  }
  const create = lists.create.length ? parseCreates(lists.create) : [];
  const update = lists.update.length ? parseUpdates(lists.update) : [];
  return { create, update };
}

export async function applyDirectiveChanges(
  api: DirectivesApi,
  changes: DirectiveChanges,
  dryRun: boolean,
) {
  const updates = await planUpdates(api, changes.update);
  const moving = updates.changes.filter(
    (change) => directiveKey(change.before) !== directiveKey(change.after),
  );
  const existing =
    changes.create.length || moving.length
      ? await existingDirectives(api)
      : { keys: new Set<string>(), count: 0 };
  const known = existing.keys;
  validateUpdatedIdentities(
    moving.map((change) => change.after),
    known,
  );
  const creations = planCreates(changes.create, known);
  if (
    creations.toCreate.length &&
    existing.count + creations.toCreate.length > MAX_PROJECT_DIRECTIVES
  )
    throw new CommandFailedError(
      'The changes would exceed the limit of 1000 directives per project. Nothing was changed.',
    );
  const touchedKeys = new Set(
    updates.changes.flatMap((change) => [directiveKey(change.before), directiveKey(change.after)]),
  );
  if (changes.create.some((item) => touchedKeys.has(directiveKey(item))))
    throw new CommandFailedError(
      'Create conflicts with an update or deletion of the same directive operation. Nothing was changed.',
    );
  const result = {
    mode: dryRun ? 'dry-run' : 'applied',
    toCreate: creations.toCreate,
    changes: updates.changes,
    skipped: creations.skipped + updates.skipped,
    created: [] as ProjectDirective[],
    updated: [] as ProjectDirective[],
  };
  if (dryRun) return result;
  let attempted = 'creation';
  let target = 'the current list';
  try {
    await inSequence(result.toCreate, async (directive) => {
      attempted = `create ${directive.type} ${directive.fromNodeKey} -> ${directive.toNodeKey}`;
      result.created.push(await api.createDirective(directive));
    });
    await inSequence(result.changes, async (change) => {
      attempted = `update ${change.id}`;
      target = `directive ${change.id}`;
      result.updated.push(await api.updateDirective(change.id, change.patch));
    });
  } catch (error) {
    const confirmed = result.created.length + result.updated.length;
    if (!confirmed && isDefiniteRejection(error)) throw error;
    throw new CommandFailedError(
      `Directive changes stopped after ${confirmed} confirmed writes. Created ids: ${result.created.map((item) => item.id).join(', ') || 'none confirmed'}. Updated ids: ${result.updated.map((item) => item.id).join(', ') || 'none'}. ${isDefiniteRejection(error) ? 'The server rejected the next directive.' : 'The attempted change may already have been applied.'} Inspect ${target} before retrying. Attempted ${attempted}. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return result;
}

function inSequence<T>(items: T[], action: (item: T) => Promise<void>): Promise<void> {
  return items.reduce((previous, item) => previous.then(() => action(item)), Promise.resolve());
}

function validateUpdatedIdentities(updates: DirectiveInput[], known: Set<string>): void {
  const afterKeys = new Set<string>();
  for (const update of updates) {
    const key = directiveKey(update);
    if (known.has(key) || afterKeys.has(key))
      throw new CommandFailedError(
        'An update would duplicate another directive. Nothing was changed.',
      );
    afterKeys.add(key);
  }
}
