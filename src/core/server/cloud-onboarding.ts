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

import type { SonarHttpClient } from './http-client.ts';

export interface GithubInstallation {
  installationId: string;
  key: string;
  name: string;
}

export interface GithubOrganization {
  almOrganization: { key: string; name: string; avatar?: string };
  boundOrganization?: { key: string; name: string };
}

export interface CloudOrganization {
  key: string;
  name: string;
  alm?: { key: string; url?: string };
  actions?: { admin: boolean };
}

export interface SubscriptionPlan {
  name: string;
  tiers: {
    priceId: string;
    currencyOptions: { unitAmount: number }[];
  }[];
}

export interface CloudSubscription {
  planKey: string;
  status?: string;
  trial?: boolean;
  trialPeriod?: { start: string; end: string };
}

/** Existing Cloud onboarding APIs; transport and regional routing stay in SonarHttpClient. */
export class CloudOnboardingClient {
  constructor(private readonly http: SonarHttpClient) {}

  listInstallations() {
    return this.http.get<{ applications: GithubInstallation[] }>(
      '/api/alm_integration/list_unbound_applications',
    );
  }

  installationInfo(installationId: string) {
    return this.http.postFormJson<GithubOrganization>(
      '/api/alm_integration/show_dop_organization',
      { installationId },
    );
  }

  applicationInfo() {
    return this.http.get<{ application: { installationUrl: string } }>(
      '/api/alm_integration/show_app_info',
    );
  }

  memberOrganizations(page: number) {
    return this.http.get<{
      organizations: CloudOrganization[];
      paging: { total: number };
    }>('/api/organizations/search', { member: true, p: page, ps: 100 });
  }

  organizationByKey(key: string) {
    return this.http.get<{ organizations: CloudOrganization[] }>('/api/organizations/search', {
      organizations: key,
    });
  }

  bindOrganization(key: string, installationId: string) {
    return this.http.postForm('/api/alm_integration/bind_organization', {
      organization: key,
      installationId,
    });
  }

  createOrganization(key: string, name: string, installationId: string) {
    return this.http.postFormJson<{ organization: { key: string; name: string } }>(
      '/api/organizations/create',
      { key, name, installationId },
    );
  }

  subscriptions(organizationId: string) {
    return this.http.get<{ subscriptions: CloudSubscription[] }>('/billing/subscriptions', {
      resourceId: organizationId,
      resourceType: 'organization',
    });
  }

  customer(organizationId: string) {
    return this.http.get<{ paymentMethodStatus?: string }>('/billing/customers', {
      resourceId: organizationId,
      resourceType: 'organization',
    });
  }

  plans() {
    return this.http.get<SubscriptionPlan[]>('/billing/plans', { product: 'SonarCloud' });
  }

  currentUser() {
    return this.http.get<{ email?: string }>('/api/users/current');
  }

  subscribe(organizationId: string, name: string, priceId?: string, email?: string) {
    return this.http.post<{ planKey?: string }>('/billing/subscriptions', {
      customerName: name,
      entityId: organizationId,
      entityType: 'organization',
      ...(priceId ? { priceId } : {}),
      ...(email ? { email } : {}),
    });
  }

  repositories(organization: string) {
    return this.http.get<{
      repositories: {
        slug?: string;
        installationKey: string;
        linkedProjects: { key: string; name: string }[];
      }[];
    }>('/api/alm_integration/list_repositories', { organization });
  }

  completedAnalyses(project: string) {
    return this.http.get<{ analyses: { key: string; date: string }[] }>(
      '/api/project_analyses/search',
      { project, ps: 1 },
    );
  }

  eligibility(projectKey: string) {
    return this.http.getOrNullIfAccepted<{ eligible: boolean; ineligibilityReason?: string }>(
      '/api/autoscan/eligibility',
      { projectKey, autoEnable: true, ignoreCache: false },
    );
  }
}
