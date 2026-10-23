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

// Public architecture endpoints for isolated integration tests.

import type {
  Ecosystem,
  IntendedArchitecture,
  IntendedGroup,
  StructureGraph,
} from '@/commands/architecture/_common/architecture-api.ts';
import type { ProjectDirective } from '@/commands/architecture/_common/directives.ts';

export const FAKE_SERVER_ORGANIZATION_ID = '00000000-0000-4000-0000-000000000000';

const MODEL_NAMESPACE_RADIX = 16;
const MODEL_SEQUENCE_LENGTH = 12;

const RESOURCES = [
  'current-architectures',
  'intended-architectures',
  'project-directives',
] as const;

export type ArchitectureResource = (typeof RESOURCES)[number];

/** The id the fake's `GET /api/project_branches/list` gives a project's main branch. */
export function fakeMainBranchId(projectKey: string): string {
  return `${projectKey}-branch-id`;
}

interface SavedGroup extends IntendedGroup {
  description?: string;
  patternId?: string;
  groups?: SavedGroup[];
}

interface SavedPerspective {
  label?: string;
  description?: string;
  qualifiers: IntendedArchitecture['type'];
  language: Ecosystem;
  groups?: SavedGroup[];
  constraints: IntendedArchitecture['constraints'];
}

interface SavedModel {
  id: string;
  perspectives: SavedPerspective[];
}

interface ArchitectureRequest {
  method: string;
  query: Record<string, string>;
  body?: string;
  /** The server id of `/intended-architectures/{id}`. */
  modelId?: string;
  contentType?: string;
}

export class FakeArchitecture {
  private readonly structure = new Map<Ecosystem, StructureGraph[]>();
  private models: SavedModel[] = [];
  private directives: ProjectDirective[] = [];

  withDirectives(directives: ProjectDirective[]): this {
    this.directives = structuredClone(directives);
    return this;
  }
  private readonly patternGroups = new Map<string, SavedGroup[]>();
  private nextModelId = 1;
  private modelNamespace = '00000000';
  private intendedReads = 0;
  private readonly staleReads = new Map<
    number,
    { id?: string; intendedArchitectures: unknown[] }
  >();
  private staleWriteResponse = false;

  withStaleWriteResponse(): this {
    this.staleWriteResponse = true;
    return this;
  }

  staleIntendedRead(readNumber: number): this {
    this.staleReads.set(readNumber, this.exportEnvelope());
    return this;
  }
  private readonly readFailures = new Map<number, number>();
  private intendedCreates = 0;
  private intendedUpdates = 0;
  private readonly updateFailures = new Map<number, { committed: boolean; status: number }>();
  private readonly committedCreateFailures = new Set<number>();
  private readonly intendedChanges = new Map<
    number,
    { models: IntendedArchitecture[]; preserveIdentity: boolean }
  >();
  private readonly createStatuses: number[] = [];
  private deleteCount = 0;
  private readonly deleteFailures = new Map<number, { committed: boolean }>();
  private readonly statusOverrides = new Map<string, { status: number; body: string }>();

  assignProjectIndex(index: number): this {
    const namespace = index
      .toString(MODEL_NAMESPACE_RADIX)
      .padStart(this.modelNamespace.length, '0');
    for (const model of this.models)
      model.id = `${namespace}${model.id.slice(this.modelNamespace.length)}`;
    this.modelNamespace = namespace;
    return this;
  }

  private allocateModelId(): string {
    return `${this.modelNamespace}-0000-4000-8000-${String(this.nextModelId++).padStart(MODEL_SEQUENCE_LENGTH, '0')}`;
  }

  withStructure(ecosystem: Ecosystem, graphs: StructureGraph[]): this {
    this.structure.set(ecosystem, graphs);
    return this;
  }

  /** One saved model holding `models`, exported back as they are. */
  withIntended(models: IntendedArchitecture[]): this {
    this.models = [this.toSavedModel(models)];
    return this;
  }

  /** One saved model in the models API shape, e.g. with a group importing a pattern. */
  withSavedPerspectives(perspectives: SavedPerspective[]): this {
    for (const perspective of perspectives) this.rememberPatterns(perspective.groups ?? []);
    this.models = [
      {
        id: this.allocateModelId(),
        perspectives,
      },
    ];
    return this;
  }

  changeImportedPattern(patternId: string, groups: SavedGroup[]): this {
    this.patternGroups.set(patternId, groups);
    const update = (children: SavedGroup[]): void => {
      for (const group of children) {
        if (group.patternId === patternId) group.groups = groups;
        else update(group.groups ?? []);
      }
    };
    for (const model of this.models)
      for (const perspective of model.perspectives) update(perspective.groups ?? []);
    return this;
  }

  withAdditionalIntended(models: IntendedArchitecture[]): this {
    this.models.push(this.toSavedModel(models));
    return this;
  }

  failIntendedRead(readNumber: number, status = 500): this {
    this.readFailures.set(readNumber, status);
    return this;
  }

  failModelUpdate(requestNumber: number, committed = false, status = 500): this {
    this.updateFailures.set(requestNumber, { committed, status });
    return this;
  }

  failModelDelete(requestNumber: number, committed = false): this {
    this.deleteFailures.set(requestNumber, { committed });
    return this;
  }

  /** Before answering the `readNumber`-th GET of the intended export, someone saves `models`. */
  changeIntendedBeforeRead(
    readNumber: number,
    models: IntendedArchitecture[],
    preserveIdentity = false,
  ): this {
    this.intendedChanges.set(readNumber, { models, preserveIdentity });
    return this;
  }

  /** The next model creations answer these statuses, in order; later ones succeed. */
  failModelCreates(...statuses: number[]): this {
    this.createStatuses.push(...statuses);
    return this;
  }

  failCommittedIntendedCreate(requestNumber: number): this {
    this.committedCreateFailures.add(requestNumber);
    return this;
  }

  /** Every request for `resource` (only those with `method`, when given) answers `status`. */
  withStatus(resource: ArchitectureResource, status: number, body = '', method?: string): this {
    this.statusOverrides.set(method ? `${resource}:${method}` : resource, { status, body });
    return this;
  }

  private readonly deletedDirectiveIds = new Set<string>();

  private directiveDeleteReadResponse?: { status: number; body: string };

  withDirectiveDeleteReadResponse(status: number, body: string): this {
    this.directiveDeleteReadResponse = { status, body };
    return this;
  }

  hasModel(id: string): boolean {
    return (
      this.models.some((model) => model.id === id) ||
      this.directives.some((item) => item.id === id) ||
      this.deletedDirectiveIds.has(id)
    );
  }

  handle(resource: ArchitectureResource, request: ArchitectureRequest): Response {
    const override =
      this.statusOverrides.get(`${resource}:${request.method}`) ??
      this.statusOverrides.get(resource);
    if (override) return json(override.body, override.status, false);

    switch (`${resource}:${request.method}`) {
      case 'project-directives:GET': {
        if (request.modelId) {
          const directive = this.directives.find((item) => item.id === request.modelId);
          return directive
            ? json(exportDirective(directive))
            : json({ message: 'Directive not found' }, 404);
        }
        const pageIndex = Number(request.query.pageIndex ?? 1);
        const pageSize = Number(request.query.pageSize ?? 50);
        return json({
          projectDirectives: this.directives
            .slice((pageIndex - 1) * pageSize, pageIndex * pageSize)
            .map(exportDirective),
          page: { pageIndex, pageSize, total: this.directives.length },
        });
      }
      case 'project-directives:POST': {
        if (request.contentType !== 'application/json')
          return json({ message: 'POST requires application/json' }, 415);
        let id: string;
        do {
          id = this.allocateModelId();
        } while (this.directives.some((item) => item.id === id));
        const directive = {
          ...JSON.parse(request.body ?? '{}'),
          id,
        } as ProjectDirective;
        this.directives.push(directive);
        return json(exportDirective(directive), 201);
      }

      case 'project-directives:PATCH': {
        if (request.contentType !== 'application/merge-patch+json')
          return json({ message: 'Wrong content type' }, 415);
        const index = this.directives.findIndex((item) => item.id === request.modelId);
        if (index < 0) return json({ message: 'Directive not found' }, 404);
        const body = JSON.parse(request.body ?? '{}');
        if (
          ['type', 'ecosystem', 'graphType', 'fromNodeKey', 'toNodeKey'].some(
            (key) => typeof body[key] !== 'string',
          )
        )
          return json({ message: 'Required structural fields are missing' }, 400);
        this.directives[index] = { ...this.directives[index], ...body };
        return json(exportDirective(this.directives[index]));
      }
      case 'project-directives:DELETE': {
        const index = this.directives.findIndex((item) => item.id === request.modelId);
        if (index < 0) return json({ message: 'Directive not found' }, 404);
        this.deletedDirectiveIds.add(this.directives[index].id);
        this.directives.splice(index, 1);
        if (this.directiveDeleteReadResponse)
          this.withStatus(
            'project-directives',
            this.directiveDeleteReadResponse.status,
            this.directiveDeleteReadResponse.body,
            'GET',
          );
        return new Response(null, { status: 204 });
      }

      case 'current-architectures:GET': {
        const graphs = this.structure.get(request.query.language as Ecosystem) ?? [];
        return json({ currentArchitectures: graphs.map(({ id: _id, ...graph }) => graph) });
      }
      case 'intended-architectures:GET': {
        const status = this.readFailures.get(this.intendedReads + 1);
        if (status !== undefined) {
          this.intendedReads++;
          return json({ message: 'Read failed' }, status);
        }
        return json(this.readIntended());
      }
      case 'intended-architectures:POST':
        return request.contentType === 'application/json'
          ? this.createIntendedArchitectures(request.body)
          : json({ message: 'POST requires application/json' }, 415);
      case 'intended-architectures:PATCH':
        return request.contentType === 'application/merge-patch+json'
          ? this.updateIntendedArchitectures(request.modelId, request.body)
          : json({ message: 'PATCH requires application/merge-patch+json' }, 415);
      case 'intended-architectures:DELETE':
        return request.modelId
          ? this.deleteModel(request.modelId)
          : json({ message: 'A model id is required' }, 400);
      default:
        return new Response(null, { status: 405 });
    }
  }

  private readIntended(): { id?: string; intendedArchitectures: unknown[] } {
    this.intendedReads++;
    const stale = this.staleReads.get(this.intendedReads);
    if (stale !== undefined) return stale;
    const change = this.intendedChanges.get(this.intendedReads);
    if (change) {
      const existing = this.models.at(0);
      if (change.preserveIdentity && existing)
        existing.perspectives = change.models.map(({ type, ...rest }) => ({
          qualifiers: type,
          ...rest,
        }));
      else this.models = [this.toSavedModel(change.models)];
    }
    return this.exportEnvelope();
  }

  private exportEnvelope(): { id?: string; intendedArchitectures: unknown[] } {
    const model = this.models[0];
    return model
      ? { id: model.id, intendedArchitectures: this.exportModel(model) }
      : { intendedArchitectures: [] };
  }

  private deleteModel(modelId: string | undefined): Response {
    const failure = this.deleteFailures.get(++this.deleteCount);
    if (!failure || failure.committed) {
      this.models = this.models.filter(({ id }) => id !== modelId);
    }
    return failure
      ? json({ message: 'Delete response failed' }, 500)
      : new Response(null, { status: 204 });
  }

  private createIntendedArchitectures(body: string | undefined): Response {
    const status = this.createStatuses.shift();
    if (status !== undefined) return json({ message: `Model rejected (${status})` }, status);
    if (this.models.length > 0)
      return json({ message: 'A model already exists for this project.' }, 400);
    const parsed = parseWriteBody(body, true);
    if (!parsed)
      return json({ message: 'POST requires projectId and intendedArchitectures only' }, 400);
    const previous = this.exportEnvelope();
    const model = this.toSavedModel(parsed);
    this.models.push(model);
    return this.committedCreateFailures.has(++this.intendedCreates)
      ? json({ message: 'Create response failed after commit' }, 500)
      : json(this.staleWriteResponse ? previous : this.exportEnvelope(), 201);
  }

  private updateIntendedArchitectures(id: string | undefined, body: string | undefined): Response {
    const model = this.models.find((model) => model.id === id);
    if (!model) return json({ message: 'Model not found' }, 404);
    const parsed = parseWriteBody(body, false);
    if (!parsed) return json({ message: 'PATCH requires intendedArchitectures only' }, 400);
    const previous = this.exportEnvelope();
    const failure = this.updateFailures.get(++this.intendedUpdates);
    if (!failure || failure.committed)
      model.perspectives = parsed.map(({ type, groups, ...rest }) => ({
        qualifiers: type,
        groups: this.saveGroups(groups),
        ...rest,
      }));
    return failure
      ? json({ message: `Patch response failed (${failure.status})` }, failure.status)
      : json(this.staleWriteResponse ? previous : this.exportEnvelope());
  }

  private exportModel({ perspectives }: SavedModel): unknown[] {
    return perspectives.map(({ qualifiers, groups, ...rest }) => ({
      qualifiers,
      groups: (groups ?? []).map(exportGroup),
      ...rest,
    }));
  }

  private rememberPatterns(groups: SavedGroup[]): void {
    for (const group of groups) {
      if (group.patternId !== undefined)
        this.patternGroups.set(group.patternId, group.groups ?? []);
      this.rememberPatterns(group.groups ?? []);
    }
  }

  private saveGroups(groups: IntendedGroup[]): SavedGroup[] {
    return groups.map((group) => ({
      ...group,
      ...(group.patternId === undefined
        ? group.groups === undefined
          ? {}
          : { groups: this.saveGroups(group.groups) }
        : { groups: this.patternGroups.get(group.patternId) ?? [] }),
    }));
  }

  private toSavedModel(models: IntendedArchitecture[]): SavedModel {
    return {
      id: this.allocateModelId(),
      perspectives: models.map(({ type, groups, ...rest }) => ({
        qualifiers: type,
        groups: this.saveGroups(groups),
        ...rest,
      })),
    };
  }
}

function exportDirective(directive: ProjectDirective) {
  return {
    ...directive,
    graphPerspective: directive.graphPerspective ?? null,
    description: directive.description ?? null,
    origin: directive.origin ?? null,
  };
}

/** The export leaves out what only the models API knows. */
function exportGroup({ groups, ...rest }: SavedGroup): IntendedGroup {
  return {
    ...rest,
    groups: (groups ?? []).map(exportGroup),
    interface: rest.interface ?? false,
    interfaceAccess: rest.interfaceAccess ?? false,
  };
}

interface ArchitectureProject {
  key: string;
  architecture?: FakeArchitecture;
}

/**
 * Routes a request to the architecture endpoints of the project its ids name, the way
 * SonarQube does: `/architecture/*` on the Cloud API host, `/api/v2/architecture/*` on
 * Server. Returns `undefined` for any other path.
 */
export function routeArchitectureRequest(
  request: {
    method: string;
    path: string;
    query: Record<string, string>;
    body?: string;
    contentType?: string;
  },
  projects: ArchitectureProject[],
  isCloud: boolean,
): Response | undefined {
  const prefix = isCloud ? '/architecture/' : '/api/v2/architecture/';
  if (!request.path.startsWith(prefix)) return undefined;
  const [resource, modelId, ...rest] = request.path.slice(prefix.length).split('/');
  if (!isResource(resource) || rest.length > 0) return undefined;

  const { query } = request;
  const projectId = fakeMainBranchId;
  let project: ArchitectureProject | undefined;
  if (resource === 'current-architectures') {
    const expectedOrganization = isCloud ? query.organizationId : FAKE_SERVER_ORGANIZATION_ID;
    if (
      !query.branchId ||
      !query.language ||
      !query.organizationId ||
      query.organizationId !== expectedOrganization
    ) {
      return json({ message: 'organizationId, branchId and language are required' }, 400);
    }
    project = projects.find(({ key }) => fakeMainBranchId(key) === query.branchId);
    if (!project) return json({ currentArchitectures: [] });
  } else if (modelId !== undefined) {
    project = projects.find(({ architecture }) =>
      architecture?.hasModel(decodeURIComponent(modelId)),
    );
  } else {
    const bodyProjectId = request.body
      ? (JSON.parse(request.body) as { projectId?: string }).projectId
      : undefined;
    project = projects.find(({ key }) => projectId(key) === (query.projectId ?? bodyProjectId));
  }
  if (!project)
    return json({ message: 'Unknown project, branch or model id' }, modelId ? 404 : 400);
  project.architecture ??= new FakeArchitecture().assignProjectIndex(projects.indexOf(project));
  return project.architecture.handle(resource, {
    method: request.method,
    query,
    body: request.body,
    modelId: modelId === undefined ? undefined : decodeURIComponent(modelId),
    contentType: request.contentType?.split(';')[0]?.trim().toLowerCase(),
  });
}

function parseWriteBody(
  body: string | undefined,
  create: boolean,
): IntendedArchitecture[] | undefined {
  const parsed = JSON.parse(body ?? '{}') as Record<string, unknown>;
  const keys = Object.keys(parsed).sort().join(',');
  if (keys !== (create ? 'intendedArchitectures,projectId' : 'intendedArchitectures'))
    return undefined;
  if (create && typeof parsed.projectId !== 'string') return undefined;
  if (!Array.isArray(parsed.intendedArchitectures) || parsed.intendedArchitectures.length === 0)
    return undefined;
  if (
    parsed.intendedArchitectures.some(
      (model: {
        qualifiers?: unknown;
        type?: unknown;
        id?: unknown;
        groups?: unknown;
        constraints?: unknown;
      }) =>
        !model ||
        model.id !== undefined ||
        model.type !== undefined ||
        (model.qualifiers !== 'file' && model.qualifiers !== 'namespace') ||
        !Array.isArray(model.groups) ||
        !Array.isArray(model.constraints),
    )
  )
    return undefined;
  return (
    parsed.intendedArchitectures as (Omit<IntendedArchitecture, 'type'> & {
      qualifiers: IntendedArchitecture['type'];
    })[]
  ).map(({ qualifiers, ...rest }) => ({ type: qualifiers, ...rest }));
}

function isResource(value: string | undefined): value is ArchitectureResource {
  return RESOURCES.some((resource) => resource === value);
}

function json(value: unknown, status = 200, encode = true): Response {
  return new Response(encode ? JSON.stringify(value) : String(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
