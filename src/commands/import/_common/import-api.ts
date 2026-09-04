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

// Every SonarQube API call `sonar import` makes, in one place next to the command.
//
// Repository listing and project provisioning are import-specific and live here. The
// organization lookups are shared, so `OrganizationsClient` is exposed as a field rather
// than re-declared method by method.

import logger from '@/core/observability/logger.ts';
import { unwrap } from '@/core/result.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';
import { OrganizationsClient } from '@/core/server/organizations.ts';

export interface DopRepository {
  id: string;
  name: string;
  slug: string;
  private: boolean;
  archived: boolean;
  boundProjectIds: string[];
  importedInCurrentOrg: boolean;
}

export interface ProvisionedProject {
  projectKey: string;
}

export class ImportApiClient {
  /** Server-enforced max `pageSize` for `/dop-translation/dop-repositories`. */
  static readonly DOP_REPOSITORIES_MAX_PAGE_SIZE = 50;

  /** One instance for the whole run, so its organization cache is shared across lookups. */
  readonly organizations: OrganizationsClient;
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
    this.organizations = new OrganizationsClient(client);
  }

  get isCloud(): boolean {
    return this.client.isCloud;
  }

  /**
   * Fetch one page of repositories visible to an organization's bound DevOps platform via
   * `/dop-translation/dop-repositories` (SonarQube Cloud only, region-specific API host).
   */
  async fetchDopRepositoriesPage(
    organizationId: string,
    pageIndex: number,
    pageSize: number,
  ): Promise<{ repositories: DopRepository[]; total: number }> {
    const endpoint = '/dop-translation/dop-repositories';
    const result = unwrap(
      await this.client.get<{
        repositories: DopRepository[];
        page: { total: number };
      }>(endpoint, { organizationId, pageIndex, pageSize }, this.client.apiHostFor(endpoint)),
    );
    return { repositories: result.repositories, total: result.page.total };
  }

  /**
   * Create (provision) a SonarQube project bound to a single DevOps platform repository via the
   * legacy `POST /api/alm_integration/provision_projects` endpoint (SonarQube Cloud only). This
   * has not migrated to the newer `dop-translation` family yet.
   *
   * `installationKey` must already be in the ALM-specific format the server expects (e.g.
   * `<slug>|<id>` for GitHub, plain `id` for other platforms).
   */
  async provisionProject(
    organization: string,
    installationKey: string,
  ): Promise<{ projects: ProvisionedProject[] }> {
    return unwrap(
      await this.client.postFormJson<{ projects: ProvisionedProject[] }>(
        '/api/alm_integration/provision_projects',
        { organization, installationKeys: installationKey },
      ),
    );
  }

  /**
   * Request SonarQube Cloud Autoscan eligibility/auto-enable for a newly provisioned project.
   * Best-effort: swallows failures so a hiccup here never fails the enclosing `sonar import` run.
   */
  async requestAutoscanEligibility(projectKey: string): Promise<void> {
    const result = await this.client.get('/api/autoscan/eligibility', {
      autoEnable: true,
      ignoreCache: false,
      projectKey,
    });
    if (!result.ok) {
      logger.debug('Failed to request autoscan eligibility', result.error);
    }
  }
}
