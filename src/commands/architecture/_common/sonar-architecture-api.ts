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
import { BranchesClient } from '@/core/server/branches.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { AccessDeniedError, UnexpectedApiError } from '@/core/server/errors.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';
import { HTTP_STATUS_NOT_FOUND } from '@/core/server/http-constants.ts';
import { OrganizationsClient } from '@/core/server/organizations.ts';

import {
  type ArchitectureApi,
  type CurrentGraph,
  type Ecosystem,
  ECOSYSTEMS,
  type IntendedArchitecture,
  type IntendedState,
  type StructureGraph,
} from './architecture-api.ts';
import {
  directiveId,
  type DirectiveInput,
  directiveKey,
  DirectiveNotFoundError,
  type DirectivePage,
  DirectivePreWriteError,
  isDefiniteRejection,
  parseProjectDirective,
  type ProjectDirective,
} from './directives.ts';
import { collectionFailure, incompatibleResponse } from './errors.ts';
import { MODEL_ID, objectField, publicGraph, toIntended } from './public-architecture-response.ts';

/** The organization id SonarQube Server's architecture endpoints expect, standing in for its single organization. */
const SERVER_ORGANIZATION_ID = '00000000-0000-4000-0000-000000000000';
const MAX_PUBLIC_PERSPECTIVES = 50;
const FIRST_SUCCESS_STATUS = 200;
const FIRST_REDIRECT_STATUS = 300;

function intendedWriteError(error: Error): Error {
  if (
    error instanceof UnexpectedApiError &&
    error.status >= FIRST_SUCCESS_STATUS &&
    error.status < FIRST_REDIRECT_STATUS
  ) {
    return incompatibleResponse(
      'Invalid public intended architecture write response: expected JSON.',
      error,
    );
  }
  return error;
}

interface ArchitectureIds {
  organizationId: string;
  branchId: string;
  /** The project UUID used by the intended architecture endpoint. */
  projectId: string;
}

interface IntendedModelExportDto extends Omit<IntendedArchitecture, 'type'> {
  qualifiers: IntendedArchitecture['type'];
}

interface CurrentArchitecturesDto {
  currentArchitectures: StructureGraph[];
}

interface IntendedResourceDto {
  id: string;
  perspectives: IntendedModelExportDto[];
}

interface IntendedArchitecturesDto {
  intendedArchitectures: IntendedResourceDto[];
}

/** The analyzed graphs of each requested ecosystem, queried in parallel. */
async function currentPerEcosystem(
  language: Ecosystem | undefined,
  read: (ecosystem: Ecosystem) => Promise<StructureGraph[]>,
): Promise<CurrentGraph[]> {
  const ecosystems = language ? [language] : ECOSYSTEMS;
  const perEcosystem = await Promise.all(
    ecosystems.map(async (ecosystem): Promise<CurrentGraph[]> => {
      const analyzed = (await read(ecosystem)).filter((candidate) => candidate.nodes.length > 0);
      return analyzed.map((graph) => ({ ecosystem, graph }));
    }),
  );
  return perEcosystem.flat();
}

export class IntendedModelIdentityError extends CommandFailedError {}

export class SonarArchitectureApi implements ArchitectureApi {
  private readonly http: SonarHttpClient;
  private idsPromise?: Promise<ArchitectureIds>;
  private intendedModelId?: string;

  constructor(
    private readonly connection: SonarConnection,
    private readonly projectKey: string,
  ) {
    this.http = connection.httpClient;
  }

  async getCurrent(language?: Ecosystem): Promise<CurrentGraph[]> {
    const { organizationId, branchId } = await this.ids();
    return currentPerEcosystem(language, async (ecosystem) => {
      const response = await this.http
        .get<CurrentArchitecturesDto | null>(this.path('current-architectures'), {
          organizationId,
          branchId,
          language: ecosystem,
        })
        .orThrow()
        .catch((error: unknown) => collectionFailure(error, this.http.isCloud));
      if (!Array.isArray(response?.currentArchitectures)) {
        throw new CommandFailedError(
          'Invalid public current architecture response: currentArchitectures must be an array.',
        );
      }
      return response.currentArchitectures.map(publicGraph);
    });
  }

  async getIntended(): Promise<IntendedArchitecture[]> {
    return (await this.getIntendedState()).models;
  }

  async getIntendedState(): Promise<IntendedState> {
    const projectId = await this.projectId();
    const response = await this.http
      .get<IntendedArchitecturesDto | null>(this.path('project-intended-architectures'), {
        projectId,
      })
      .orThrow()
      .catch((error: unknown) => collectionFailure(error, this.http.isCloud));
    if (!Array.isArray(response?.intendedArchitectures)) {
      throw incompatibleResponse(
        'Invalid public intended architecture response: intendedArchitectures must be an array.',
      );
    }
    if (response.intendedArchitectures.length > 1) {
      throw incompatibleResponse(
        'Invalid public intended architecture response: expected at most one resource.',
      );
    }
    const resource = response.intendedArchitectures.at(0);
    if (resource === undefined) return { models: [] };
    const state = this.parseIntendedResource(resource);
    if (this.intendedModelId !== undefined && this.intendedModelId !== state.id) {
      throw new IntendedModelIdentityError(
        'The intended architecture model identity changed; read the current state before retrying.',
      );
    }
    this.intendedModelId = state.id;
    return state;
  }

  private parseIntendedResource(value: unknown): IntendedState {
    const resource = objectField(value);
    if (
      typeof resource.id !== 'string' ||
      !MODEL_ID.test(resource.id) ||
      !Array.isArray(resource.perspectives) ||
      resource.perspectives.length > MAX_PUBLIC_PERSPECTIVES
    ) {
      throw incompatibleResponse(
        'Invalid public intended architecture response: expected a resource id and perspectives.',
      );
    }
    const models = resource.perspectives.map(toIntended);
    const identities = models.map(({ type, language }) => `${type}/${language}`);
    if (new Set(identities).size !== identities.length) {
      throw incompatibleResponse(
        'Invalid public intended architecture response: duplicate perspectives.',
      );
    }
    return { id: resource.id, models };
  }

  async createIntended(models: IntendedArchitecture[]): Promise<void> {
    const response = await this.http
      .post<IntendedResourceDto | null>(this.path('project-intended-architectures'), {
        projectId: await this.projectId(),
        perspectives: models.map(({ type, ...model }) => ({ qualifiers: type, ...model })),
      })
      .mapErr(intendedWriteError)
      .orThrow();
    this.verifySaved(response);
  }

  async updateIntended(models: IntendedArchitecture[]): Promise<void> {
    const response = await this.http
      .patch<IntendedResourceDto | null>(this.modelPath(), {
        perspectives: models.map(({ type, ...model }) => ({ qualifiers: type, ...model })),
      })
      .mapErr(intendedWriteError)
      .orThrow();
    this.verifySaved(response);
  }

  async deleteIntended(): Promise<void> {
    await this.http.delete(this.modelPath()).orThrow();
  }

  async getDirectivesPage(pageIndex: number, pageSize: number): Promise<DirectivePage> {
    if (
      !Number.isSafeInteger(pageIndex) ||
      pageIndex < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 1000
    )
      throw new CommandFailedError(
        'Directive page must be >= 1 and page size must be between 1 and 1000.',
      );
    const projectId = await this.projectId('Project directives');
    const result = await this.http
      .get<{
        projectDirectives?: unknown[];
        page?: { pageIndex: number; pageSize: number; total: number };
      } | null>(this.path('project-directives'), { projectId, pageIndex, pageSize })
      .orThrow();
    const page = result?.page;
    if (
      !Array.isArray(result?.projectDirectives) ||
      page?.pageIndex !== pageIndex ||
      page.pageSize !== pageSize ||
      !Number.isSafeInteger(page.total) ||
      page.total < 0 ||
      result.projectDirectives.length > pageSize
    )
      throw new CommandFailedError('Invalid public directives page; no complete page was read.');
    const directives = result.projectDirectives.map((item) => parseProjectDirective(item));
    if (new Set(directives.map((item) => item.id.toLowerCase())).size !== directives.length)
      throw new CommandFailedError('The public directives page returned duplicate ids.');
    if (directives.some((item) => item.projectId !== projectId))
      throw new CommandFailedError('The public directives page returned a different project.');
    return { directives, page };
  }

  async createDirective(directive: DirectiveInput): Promise<ProjectDirective> {
    const projectId = await this.projectId('Project directives');
    const result = await this.http
      .post<unknown>(this.path('project-directives'), {
        ...directive,
        projectId,
        origin: 'sonarqube-cli',
      })
      .orThrow();
    const created = parseProjectDirective(result);
    if (created.projectId !== projectId)
      throw new CommandFailedError(
        'The directive write returned a different project. Inspect the current list before retrying.',
      );
    if (
      directiveKey(created) !== directiveKey(directive) ||
      (directive.description !== undefined && directive.description !== created.description)
    )
      throw new CommandFailedError(
        'The directive write response did not confirm the requested directive. Inspect the current list before retrying.',
      );
    return created;
  }

  async getDirective(id: string): Promise<ProjectDirective> {
    const projectId = await this.projectId('Project directives');
    const result = await this.http
      .get<unknown>(this.directivePath(id))
      .orThrow()
      .catch((error: unknown) => {
        if (error instanceof AccessDeniedError && error.status === HTTP_STATUS_NOT_FOUND)
          throw new DirectiveNotFoundError(
            `Directive ${id} was not found or is not accessible in the selected project.`,
            { cause: error },
          );
        throw error;
      });
    const directive = parseProjectDirective(result);
    if (directive.id.toLowerCase() !== directiveId(id) || directive.projectId !== projectId)
      throw new CommandFailedError(
        'The public directive response returned a different id or project. Nothing was changed.',
      );
    return directive;
  }

  private readDirectiveBeforeWrite(id: string): Promise<ProjectDirective> {
    return this.getDirective(id).catch((error: unknown) => {
      const message =
        isDefiniteRejection(error) && error instanceof Error
          ? error.message
          : `The current state of directive ${id} could not be verified.`;
      throw new DirectivePreWriteError(message, { cause: error });
    });
  }

  async updateDirective(id: string, directive: DirectiveInput): Promise<ProjectDirective> {
    const current = await this.readDirectiveBeforeWrite(id);
    const payload = {
      ...directive,
      ...(current.origin === undefined ? {} : { origin: current.origin }),
    };
    const response = await this.http.patch<unknown>(this.directivePath(id), payload).orThrow();
    const updated = parseProjectDirective(response);
    const projectId = await this.projectId('Project directives');
    if (
      updated.id.toLowerCase() !== directiveId(id) ||
      updated.projectId !== projectId ||
      directiveKey(updated) !==
        directiveKey({
          ...directive,
          graphPerspective: directive.graphPerspective ?? current.graphPerspective,
        }) ||
      (directive.description !== undefined && updated.description !== directive.description)
    )
      throw new CommandFailedError(
        'The directive update response did not confirm the requested directive. Inspect it before retrying.',
      );
    return updated;
  }

  async deleteDirective(id: string): Promise<void> {
    await this.readDirectiveBeforeWrite(id);
    let deleteAccepted = false;
    try {
      await this.http
        .delete(this.directivePath(id))
        .orThrow()
        .catch((error: unknown) => {
          if (error instanceof UnexpectedApiError && error.status === HTTP_STATUS_NOT_FOUND)
            throw new DirectiveNotFoundError(
              `Directive ${id} was not found or is not accessible in the selected project.`,
              { cause: error },
            );
          throw error;
        });
      deleteAccepted = true;
      const { response } = await this.http.getSafe<unknown>(this.directivePath(id)).orThrow();
      if (response.status !== HTTP_STATUS_NOT_FOUND)
        throw new CommandFailedError(
          `Expected HTTP 404 after deletion, received ${response.status}.`,
        );
    } catch (error) {
      if (!deleteAccepted && isDefiniteRejection(error)) throw error;
      throw new CommandFailedError(
        `Directive deletion could not be confirmed. Inspect directive ${id} before retrying. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private directivePath(id: string): string {
    return `${this.path('project-directives')}/${directiveId(id)}`;
  }

  private modelPath(): string {
    if (!this.intendedModelId) {
      throw new CommandFailedError(
        'Cannot change an intended architecture without its server id from a public read.',
      );
    }
    return `${this.path('project-intended-architectures')}/${encodeURIComponent(this.intendedModelId)}`;
  }

  private verifySaved(response: IntendedResourceDto | null): void {
    if (!response) {
      throw incompatibleResponse(
        'Invalid public intended architecture write response: missing resource.',
      );
    }
    const state = this.parseIntendedResource(response);
    if (state.models.length === 0) {
      throw incompatibleResponse(
        'Invalid public intended architecture write response: missing perspectives.',
      );
    }
    if (this.intendedModelId !== undefined && this.intendedModelId !== state.id) {
      throw new IntendedModelIdentityError(
        'The intended architecture model identity changed; read the current state before retrying.',
      );
    }
    this.intendedModelId = state.id;
  }

  private path(resource: string): string {
    return this.http.isCloud ? `/architecture/${resource}` : `/api/v2/architecture/${resource}`;
  }

  private ids(): Promise<ArchitectureIds> {
    this.idsPromise ??= this.resolveIds();
    return this.idsPromise;
  }

  private async resolveIds(): Promise<ArchitectureIds> {
    const branches = await new BranchesClient(this.http).listBranches(this.projectKey).orThrow();
    const branchId = branches.find((branch) => branch.isMain)?.branchId;
    if (!branchId) {
      throw new CommandFailedError(`Project '${this.projectKey}' has no analyzed main branch.`, {
        remediationHint: 'Run an analysis of the main branch first.',
      });
    }
    if (this.http.isCloud) {
      // On SonarQube Cloud the architecture endpoints key a project by its main branch id.
      return { organizationId: await this.cloudOrganizationId(), branchId, projectId: branchId };
    }
    return {
      organizationId: SERVER_ORGANIZATION_ID,
      branchId,
      projectId: branchId,
    };
  }

  private async cloudOrganizationId(): Promise<string> {
    const { orgKey } = this.connection.auth;
    if (!orgKey) {
      throw new CommandFailedError('No SonarQube Cloud organization is configured.', {
        remediationHint: "Run 'sonar auth login --org <org>'.",
      });
    }
    const organizationId = await new OrganizationsClient(this.http)
      .getOrganizationId(orgKey)
      .orThrow();
    if (!organizationId) {
      throw new CommandFailedError(`Organization '${orgKey}' was not found.`);
    }
    return organizationId;
  }

  private async projectId(resource = 'Intended architecture'): Promise<string> {
    if (!this.http.isCloud) {
      throw new CommandFailedError(
        `${resource} is not available yet on SonarQube Server: the public API requires a project UUID that cannot be discovered through a confirmed public endpoint.`,
      );
    }
    return (await this.ids()).projectId;
  }
}
