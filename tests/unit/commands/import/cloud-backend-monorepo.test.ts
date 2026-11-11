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

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { CloudImportPlan } from '@/commands/import/cloud-import-plan.ts';
import { ImportApiClient } from '@/commands/import/import-api.ts';
import { SONARCLOUD_URL } from '@/core/config-constants.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import {
  fakeResponse,
  lastFetchInit,
  lastFetchUrl,
  mockFetch,
  mockFetchSeq,
} from '../../helpers/mock-fetch.ts';

const PROJECTS = [
  { projectKey: 'org_api', projectName: 'API' },
  { projectKey: 'org_web', projectName: 'Web' },
];

describe('CloudImportPlan.importMonorepo', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  function client(): ImportApiClient {
    return new ImportApiClient(new SonarHttpClient(SONARCLOUD_URL, 'token'));
  }

  function plan(): CloudImportPlan {
    return new CloudImportPlan(client(), 'org', undefined, SONARCLOUD_URL, {
      kind: 'batch',
      repos: [],
      skipped: [],
    });
  }

  const REPO = { slug: 'owner/repo', installationKey: 'owner/repo|42' };

  function run() {
    const reports: Array<[string, string, string | undefined]> = [];
    const done = plan().importMonorepo(REPO, PROJECTS, (k, s, d) => reports.push([k, s, d]));
    return { reports, done };
  }

  it('sends one batch with the installation key on every project', async () => {
    fetchSpy = mockFetch({ projects: PROJECTS.map(({ projectKey }) => ({ projectKey })) });

    await run().done;

    expect(lastFetchUrl(fetchSpy)).toContain('/api/alm_integration/provision_monorepo_projects');
    expect(JSON.parse(lastFetchInit(fetchSpy).body as string)).toEqual({
      organization: 'org',
      projects: PROJECTS.map((project) => ({ ...project, installationKey: 'owner/repo|42' })),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('reports every created project as done', async () => {
    fetchSpy = mockFetch({ projects: PROJECTS.map(({ projectKey }) => ({ projectKey })) });
    const { reports, done } = run();
    await done;

    expect(reports.filter(([, status]) => status === 'done').map(([key]) => key)).toEqual([
      'org_api',
      'org_web',
    ]);
  });

  describe('when the server refuses part of the batch with a 400', () => {
    function refusal(...messages: string[]) {
      return fakeResponse({ errors: messages.map((msg) => ({ msg })) }, { status: 400 });
    }

    it('reports a refused project with its own reason and the others as done, without any lookup', async () => {
      fetchSpy = mockFetchSeq(
        refusal(
          'Could not provision some of the projects (1/2)',
          'org_api: Project key already exists',
        ),
      );
      const { reports, done } = run();
      await done;

      expect(reports).toContainEqual(['org_api', 'failed', 'Project key already exists']);
      expect(reports).toContainEqual(['org_web', 'done', undefined]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('attributes a refusal to the longest matching key, since a key may contain a colon', async () => {
      const keys = ['org', 'org: api'];
      fetchSpy = mockFetchSeq(
        refusal(
          'Could not provision some of the projects (1/2)',
          'org: api: Project key already exists',
        ),
      );
      const reports: Array<[string, string, string | undefined]> = [];
      await plan().importMonorepo(
        REPO,
        keys.map((projectKey) => ({ projectKey, projectName: projectKey })),
        (k, s, d) => reports.push([k, s, d]),
      );

      expect(reports).toContainEqual(['org: api', 'failed', 'Project key already exists']);
      expect(reports).toContainEqual(['org', 'done', undefined]);
    });

    it('looks up a project it cannot account for, and fails only the one that does not exist', async () => {
      const respond = (input: string | URL | Request): Promise<Response> => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.includes('provision_monorepo_projects')) {
          return Promise.resolve(refusal('Could not provision some of the projects (1/2)'));
        }
        return Promise.resolve(
          url.includes('component=org_api')
            ? fakeResponse({ component: { key: 'org_api', name: 'API', qualifier: 'TRK' } })
            : fakeResponse({}, { status: 404 }),
        );
      };
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(respond as typeof fetch);
      const { reports, done } = run();
      await done;

      expect(reports).toContainEqual(['org_api', 'done', undefined]);
      expect(reports).toContainEqual([
        'org_web',
        'failed',
        'SonarQube Cloud did not create this project.',
      ]);
    });

    it('fails every project with the server message when the 400 has no summary line', async () => {
      fetchSpy = mockFetchSeq(refusal("The 'organization' parameter is missing"));
      const { reports, done } = run();
      await done;

      expect(reports.filter(([, status]) => status === 'failed')).toEqual([
        ['org_api', 'failed', "The 'organization' parameter is missing"],
        ['org_web', 'failed', "The 'organization' parameter is missing"],
      ]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('never assumes a project the response does not mention was created', async () => {
    fetchSpy = mockFetch({ projects: [{ projectKey: 'org_api' }] });
    const { reports, done } = run();
    await done;

    const web = reports.find(([key, status]) => key === 'org_web' && status === 'failed');
    expect(web?.[2]).toContain('did not create');
  });

  it('fails every project when the call itself fails', async () => {
    fetchSpy = mockFetch({ message: 'boom' }, { status: 500 });
    const { reports, done } = run();
    await done;

    expect(reports.filter(([, status]) => status === 'failed')).toHaveLength(2);
  });
});
