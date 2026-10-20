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
import type { SonarHttpClient } from '@/core/server/http-client.ts';
import { OrganizationsClient } from '@/core/server/organizations.ts';

import {
  type ArchitectureApi,
  type CurrentGraph,
  type Ecosystem,
  ECOSYSTEMS,
  type IntendedArchitecture,
  type IntendedGroup,
  type StructureGraph,
  type StructureNode,
} from './architecture-api.ts';
import { revisionOf } from './intended-model.ts';

/** The organization id SonarQube Server's architecture endpoints expect, standing in for its single organization. */
const SERVER_ORGANIZATION_ID = '00000000-0000-4000-0000-000000000000';
const MAX_PUBLIC_GROUPS = 50_000;
const MAX_PUBLIC_GROUP_DEPTH = 64;
const MODEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ArchitectureIds {
  organizationId: string;
  branchId: string;
  /** The project UUID used by the intended architecture endpoint. */
  projectId: string;
}

interface IntendedModelExportDto extends IntendedArchitecture {
  id: string;
}

interface CurrentArchitecturesDto {
  currentArchitectures: StructureGraph[];
}

interface IntendedArchitecturesDto {
  intendedArchitectures: IntendedModelExportDto[];
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

function invalidPublicModel(): never {
  throw new CommandFailedError(
    'Invalid public intended architecture response: invalid model field shape.',
  );
}

function objectField(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return invalidPublicModel();
  return value as Record<string, unknown>;
}

function toIntended(value: unknown): IntendedArchitecture {
  const { type, language, groups, constraints } = objectField(value);
  if (
    (type !== 'file' && type !== 'namespace') ||
    typeof language !== 'string' ||
    !(ECOSYSTEMS as readonly string[]).includes(language) ||
    !Array.isArray(groups) ||
    !Array.isArray(constraints)
  )
    return invalidPublicModel();
  const budget = { count: 0 };
  return {
    type,
    language: language as Ecosystem,
    groups: groups.map((group: unknown) => publicGroup(group, 0, budget)),
    constraints: constraints.map((value: unknown) => {
      const { from, to } = objectField(value);
      if (typeof from !== 'string' || typeof to !== 'string') return invalidPublicModel();
      return { from, to };
    }),
  };
}

function publicGroup(value: unknown, depth: number, budget: { count: number }): IntendedGroup {
  if (depth > MAX_PUBLIC_GROUP_DEPTH || ++budget.count > MAX_PUBLIC_GROUPS)
    return invalidPublicModel();
  const group = objectField(value);
  if (
    typeof group.label !== 'string' ||
    (group.patterns !== undefined &&
      (!Array.isArray(group.patterns) ||
        group.patterns.some((pattern: unknown) => typeof pattern !== 'string'))) ||
    (group.groups !== undefined && !Array.isArray(group.groups)) ||
    (group.interface !== undefined && typeof group.interface !== 'boolean') ||
    (group.interfaceAccess !== undefined && typeof group.interfaceAccess !== 'boolean')
  )
    return invalidPublicModel();
  return {
    label: group.label,
    ...(group.patterns === undefined ? {} : { patterns: group.patterns as string[] }),
    ...(group.groups === undefined
      ? {}
      : {
          groups: (group.groups as unknown[]).map((child) => publicGroup(child, depth + 1, budget)),
        }),
    ...(group.interface === undefined ? {} : { interface: group.interface }),
    ...(group.interfaceAccess === undefined ? {} : { interfaceAccess: group.interfaceAccess }),
  };
}

function invalidPublicGraph(): never {
  throw new CommandFailedError(
    'Invalid public current architecture response: invalid graph field shape.',
  );
}

function graphObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return invalidPublicGraph();
  return value as Record<string, unknown>;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function publicGraph(value: unknown): StructureGraph {
  const graph = graphObject(value);
  if (!isInteger(graph.nodeCount) || !isInteger(graph.edgeCount) || !Array.isArray(graph.nodes))
    return invalidPublicGraph();
  const budget = { count: 0 };
  return {
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    nodes: graph.nodes.map((node: unknown) => publicNode(node, 0, budget)),
  };
}

function publicNode(value: unknown, depth: number, budget: { count: number }): StructureNode {
  if (depth > 256 || ++budget.count > 1_000_000) return invalidPublicGraph();
  const node = graphObject(value);
  if (
    !isInteger(node.id) ||
    typeof node.name !== 'string' ||
    typeof node.kind !== 'string' ||
    !Array.isArray(node.edges) ||
    (node.nodes !== undefined && !Array.isArray(node.nodes)) ||
    (node.separator !== undefined && typeof node.separator !== 'string')
  )
    return invalidPublicGraph();
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    edges: node.edges.map((value: unknown) => {
      const edge = graphObject(value);
      if (!isInteger(edge.toId) || !isInteger(edge.weight)) return invalidPublicGraph();
      return { toId: edge.toId, weight: edge.weight };
    }),
    ...(node.nodes === undefined
      ? {}
      : { nodes: (node.nodes as unknown[]).map((child) => publicNode(child, depth + 1, budget)) }),
    ...(node.separator === undefined ? {} : { separator: node.separator }),
  };
}

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
          ecosystem,
        })
        .orThrow();
      if (!Array.isArray(response?.currentArchitectures)) {
        throw new CommandFailedError(
          'Invalid public current architecture response: currentArchitectures must be an array.',
        );
      }
      return response.currentArchitectures.map(publicGraph);
    });
  }

  async getIntended(): Promise<IntendedArchitecture[]> {
    const projectId = await this.projectId();
    const response = await this.http
      .get<IntendedArchitecturesDto | null>(this.path('intended-architectures'), { projectId })
      .orThrow();
    if (!Array.isArray(response?.intendedArchitectures)) {
      throw new CommandFailedError(
        'Invalid public intended architecture response: intendedArchitectures must be an array.',
      );
    }
    if (
      response.intendedArchitectures.some(
        (model: unknown) => model === null || typeof model !== 'object',
      )
    ) {
      throw new CommandFailedError(
        'Invalid public intended architecture response: each model must be an object.',
      );
    }
    const ids = new Set(response.intendedArchitectures.map(({ id }) => id));
    if ([...ids].some((id) => typeof id !== 'string' || !MODEL_ID.test(id)) || ids.size > 1) {
      throw new CommandFailedError(
        'Invalid public intended architecture response: expected one stored model with a server id.',
      );
    }
    const id = response.intendedArchitectures.at(0)?.id;
    if (this.intendedModelId !== undefined && id !== undefined && this.intendedModelId !== id) {
      throw new CommandFailedError(
        'The intended architecture model identity changed; read the current state before retrying.',
      );
    }
    this.intendedModelId ??= id;
    return response.intendedArchitectures.map(toIntended);
  }

  async createIntended(models: IntendedArchitecture[]): Promise<void> {
    const response = await this.http
      .post<IntendedArchitecturesDto | null>(this.path('intended-architectures'), {
        projectId: await this.projectId(),
        intendedArchitectures: models,
      })
      .orThrow();
    this.verifySaved(response, models);
  }

  async updateIntended(models: IntendedArchitecture[]): Promise<void> {
    const response = await this.http
      .patch<IntendedArchitecturesDto | null>(this.modelPath(), { intendedArchitectures: models })
      .orThrow();
    this.verifySaved(response, models);
  }

  async deleteIntended(): Promise<void> {
    await this.http.delete(this.modelPath()).orThrow();
  }

  private modelPath(): string {
    if (!this.intendedModelId) {
      throw new CommandFailedError(
        'Cannot change an intended architecture without its server id from a public read.',
      );
    }
    return `${this.path('intended-architectures')}/${encodeURIComponent(this.intendedModelId)}`;
  }

  private verifySaved(
    response: IntendedArchitecturesDto | null,
    models: IntendedArchitecture[],
  ): void {
    if (
      !Array.isArray(response?.intendedArchitectures) ||
      response.intendedArchitectures.length === 0
    ) {
      throw new CommandFailedError(
        'Invalid public intended architecture write response: missing model envelope or server id.',
      );
    }
    const ids = new Set(response.intendedArchitectures.map(({ id }) => id));
    const id = response.intendedArchitectures.at(0)?.id;
    if (
      ids.size !== 1 ||
      typeof id !== 'string' ||
      !MODEL_ID.test(id) ||
      (this.intendedModelId !== undefined && this.intendedModelId !== id)
    ) {
      throw new CommandFailedError(
        'Invalid public intended architecture write response: unexpected server model id.',
      );
    }
    if (revisionOf(response.intendedArchitectures.map(toIntended)) !== revisionOf(models)) {
      throw new CommandFailedError(
        'Invalid public intended architecture write response: returned content does not match the requested model.',
      );
    }
    this.intendedModelId = id;
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

  private async projectId(): Promise<string> {
    if (!this.http.isCloud) {
      throw new CommandFailedError(
        'Intended architecture is not available yet on SonarQube Server: the public API requires a project UUID that cannot be discovered through a confirmed public endpoint.',
      );
    }
    return (await this.ids()).projectId;
  }
}
