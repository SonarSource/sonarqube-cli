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

import { afterEach, describe, expect, it } from 'bun:test';

import { ServerImportApiClient } from '@/commands/import/server/server-import-api.ts';
import { ServerBackend } from '@/commands/import/server-backend.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';
import { TestHarness } from '../../harness';

const SETTING = { id: 'gl-id', key: 'gitlab', type: 'gitlab', url: 'https://gitlab.example.com' };
const FIRST = { id: 1, name: 'my_repo', slug: 'my_repo', pathSlug: 'group', pathName: 'group' };
const SECOND = { id: 2, name: 'repo', slug: 'repo', pathSlug: 'group_my', pathName: 'group_my' };
const KEY = 'group_my_repo';

describe('concurrent Server imports', () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.dispose();
  });

  it.each([false, true])(
    'preserves the winning binding (same repository: %s)',
    async (sameRepository) => {
      harness = await TestHarness.create();
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withVersion('2025.1.0.102418')
        .withDopSettings([SETTING])
        .withGitlabRepos('gitlab', [FIRST, SECOND])
        .start();
      let release = () => {};
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let arrivals = 0;
      const plans = await Promise.all(
        ['group/my_repo', sameRepository ? 'group/my_repo' : 'group_my/repo'].map(async (slug) => {
          const api = new ServerImportApiClient(
            new SonarHttpClient(server.baseUrl(), 'test-token'),
            server.baseUrl(),
          );
          const lookup = api.lookupProject.bind(api);
          api.lookupProject = async (key) => {
            const result = await lookup(key);
            if (result === 'missing') {
              arrivals++;
              if (arrivals === 2) release();
              await barrier;
            }
            return result;
          };
          const plan = await new ServerBackend(api, server.baseUrl()).plan(
            { repo: [slug], nonInteractive: true },
            new FakeConsole(),
          );
          if (plan.selection.kind !== 'batch') throw new Error('Expected batch');
          return { plan, repo: plan.selection.repos[0] };
        }),
      );
      try {
        const outcomes = await Promise.allSettled(
          plans.map(({ plan, repo }) => plan.importRepo(repo)),
        );
        expect(arrivals).toBe(2);
        expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(
          sameRepository ? 2 : 1,
        );
        if (!sameRepository) {
          const loser = outcomes.find((o) => o.status === 'rejected');
          expect(loser).toMatchObject({
            reason: { message: expect.stringContaining('already exists and is not bound') },
          });
        } else {
          expect(
            outcomes.filter((o) => o.status === 'fulfilled' && o.value !== undefined),
          ).toHaveLength(1);
        }
        const mutations = server
          .getRecordedRequests()
          .filter((r) => r.path === '/api/v2/dop-translation/bound-projects');
        expect(mutations).toHaveLength(2);
        expect(mutations.every((r) => r.method === 'POST')).toBe(true);
        const winnerIndex = outcomes.findIndex((o) => o.status === 'fulfilled');
        const winnerId = sameRepository ? '1' : String(winnerIndex + 1);
        const api = new ServerImportApiClient(
          new SonarHttpClient(server.baseUrl(), 'test-token'),
          server.baseUrl(),
        );
        const binding = await api.findProjectBinding(
          'gl-id',
          winnerId,
          (candidate) => candidate.projectKey === KEY,
        );
        expect(binding).toMatchObject({ repository: winnerId, devOpsPlatformSettingId: 'gl-id' });
        const winner = plans[winnerIndex];
        expect(await winner.plan.importRepo(winner.repo)).toEqual({
          detail: 'project already exists with matching binding',
        });
        expect(
          server
            .getRecordedRequests()
            .filter((r) => r.path === '/api/v2/dop-translation/bound-projects'),
        ).toHaveLength(2);
      } finally {
        release();
      }
    },
  );
});
