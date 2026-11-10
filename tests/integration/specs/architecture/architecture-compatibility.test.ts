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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { ProjectDirective } from '@/commands/architecture/_common/directives.ts';

import { TestHarness } from '../../harness';
import { INTENDED_RESOURCE } from '../../harness/fake-architecture';

const COMPATIBILITY = 'supports the same public Architecture API';

describe('Architecture API compatibility diagnostics', () => {
  let harness: TestHarness;
  beforeEach(async () => {
    harness = await TestHarness.create();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it.each(['page', 'single', 'create', 'update'] as const)(
    'keeps compatibility guidance for a malformed directive record in a %s response',
    async (operation) => {
      const directive: ProjectDirective = {
        id: '11111111-1111-4111-8111-111111111111',
        projectId: 'shop-branch-id',
        type: 'REMOVE_EDGE',
        ecosystem: 'java',
        graphType: 'namespace_graph',
        fromNodeKey: 'app:a',
        toNodeKey: 'app:b',
        origin: 'sonarqube-cli',
      };
      const method = operation === 'create' ? 'POST' : operation === 'update' ? 'PATCH' : 'GET';
      const response =
        operation === 'page'
          ? { projectDirectives: [{}], page: { pageIndex: 1, pageSize: 50, total: 1 } }
          : {};
      const server = await harness
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken('test-token')
        .withProject('shop', (project) =>
          project.withArchitecture((architecture) =>
            architecture
              .withDirectives(operation === 'single' || operation === 'update' ? [directive] : [])
              .withStatus(
                'project-directives',
                operation === 'create' ? 201 : 200,
                JSON.stringify(response),
                method,
              ),
          ),
        )
        .start();
      harness.withAuth(server.recordedAuthServerUrl(), 'test-token', 'my-org');
      const changes =
        operation === 'create'
          ? {
              create: [
                {
                  type: 'REMOVE_EDGE',
                  ecosystem: 'java',
                  graphType: 'namespace_graph',
                  fromNodeKey: 'app:a',
                  toNodeKey: 'app:b',
                },
              ],
            }
          : { update: [{ id: directive.id, description: 'Changed description' }] };
      harness.cwd.writeFile('changes.json', JSON.stringify(changes));
      const command =
        operation === 'page'
          ? 'directives get -p shop --format json'
          : operation === 'single'
            ? `directives get -p shop --id ${directive.id} --format json`
            : 'directives set -p shop --file changes.json';
      const result = await harness.run(`arch ${command}`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(COMPATIBILITY);
      expect(result.stderr).toContain('sonar update');
      const writes = server
        .getRecordedRequests()
        .filter((request) => ['POST', 'PATCH', 'DELETE'].includes(request.method));
      expect(writes.map((request) => request.method)).toEqual(
        operation === 'create' ? ['POST'] : operation === 'update' ? ['PATCH'] : [],
      );
    },
  );

  for (const cloud of [false, true]) {
    for (const target of ['current', 'intended', 'directives'] as const) {
      it(`offers an update for a non-JSON ${target} response on ${cloud ? 'Cloud' : 'Server'}`, async () => {
        const builder = harness
          .newFakeServer()
          .withVersion('2026.6')
          .withAuthToken('test-token')
          .withProject('shop', (project) =>
            project.withArchitecture((architecture) =>
              architecture.withStatus(
                target === 'current'
                  ? 'current-architectures'
                  : target === 'intended'
                    ? INTENDED_RESOURCE
                    : 'project-directives',
                200,
                '<html>Gateway response</html>',
                'GET',
              ),
            ),
          );
        const server = await (cloud ? builder.asSonarCloud() : builder).start();
        harness.withAuth(
          cloud ? server.recordedAuthServerUrl() : server.baseUrl(),
          'test-token',
          cloud ? 'my-org' : undefined,
        );
        const result = await harness.run(
          `arch ${target} get -p shop --format json${target === 'current' ? ' --language java' : ''}`,
        );
        if (!cloud) {
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain(
            'The sonar architecture command requires a SonarQube Cloud connection.',
          );
          return;
        }
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('sonar update');
        expect(result.stderr).toContain('Architecture API');
        expect(
          server
            .getRecordedRequests()
            .filter(
              (request) =>
                ['POST', 'PATCH', 'DELETE'].includes(request.method) &&
                request.path.includes('/architecture/'),
            ),
        ).toEqual([]);
      });
    }

    for (const target of ['current', 'intended', 'directives'] as const) {
      it(`explains an incompatible ${target} envelope on ${cloud ? 'Cloud' : 'Server'} without writing`, async () => {
        const builder = harness
          .newFakeServer()
          .withVersion('2026.6')
          .withAuthToken('test-token')
          .withProject('shop', (project) =>
            project.withArchitecture((architecture) =>
              architecture.withStatus(
                target === 'current'
                  ? 'current-architectures'
                  : target === 'intended'
                    ? INTENDED_RESOURCE
                    : 'project-directives',
                200,
                '{}',
                'GET',
              ),
            ),
          );
        const server = await (cloud ? builder.asSonarCloud() : builder).start();
        harness.withAuth(
          cloud ? server.recordedAuthServerUrl() : server.baseUrl(),
          'test-token',
          cloud ? 'my-org' : undefined,
        );
        const result = await harness.run(
          `arch ${target} get -p shop --format json${target === 'current' ? ' --language java' : ''}`,
        );
        if (!cloud) {
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain(
            'The sonar architecture command requires a SonarQube Cloud connection.',
          );
          return;
        }
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(COMPATIBILITY);
        expect(result.stderr).toContain('sonar update');
        expect(result.stdout).not.toContain(COMPATIBILITY);
        expect(
          server
            .getRecordedRequests()
            .filter(
              (request) =>
                ['POST', 'PATCH', 'DELETE'].includes(request.method) &&
                request.path.includes('/architecture/'),
            ),
        ).toEqual([]);
      });
    }
    it(`explains malformed directives page fields but keeps value mismatches separate on ${cloud ? 'Cloud' : 'Server'}`, async () => {
      for (const [page, compatibleShape] of [
        [{ pageIndex: '1', pageSize: 50, total: 0 }, false],
        [{ pageIndex: 1, total: 0 }, false],
        [{ pageIndex: 1, pageSize: 50, total: 0.5 }, false],
        [{ pageIndex: 2, pageSize: 50, total: 0 }, true],
      ] as const) {
        const builder = harness
          .newFakeServer()
          .withVersion('2026.6')
          .withAuthToken('test-token')
          .withProject('shop', (project) =>
            project.withArchitecture((architecture) =>
              architecture.withStatus(
                'project-directives',
                200,
                JSON.stringify({ projectDirectives: [], page }),
                'GET',
              ),
            ),
          );
        const server = await (cloud ? builder.asSonarCloud() : builder).start();
        harness.withAuth(
          cloud ? server.recordedAuthServerUrl() : server.baseUrl(),
          'test-token',
          cloud ? 'my-org' : undefined,
        );
        const result = await harness.run('arch directives get -p shop --format json');
        if (!cloud) {
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain(
            'The sonar architecture command requires a SonarQube Cloud connection.',
          );
          return;
        }
        expect(result.exitCode).toBe(1);
        if (compatibleShape) {
          expect(result.stderr).not.toContain(COMPATIBILITY);
          expect(result.stderr).toContain('did not match the requested page');
          expect(result.stderr).not.toContain('sonar update');
        } else {
          expect(result.stderr).toContain(COMPATIBILITY);
          expect(result.stderr).toContain('sonar update');
        }
      }
    });

    it(`keeps an explicit directive 404 distinct while explaining Server availability on ${cloud ? 'Cloud' : 'Server'}`, async () => {
      const builder = harness
        .newFakeServer()
        .withVersion('2026.6')
        .withAuthToken('test-token')
        .withProject('shop', (project) => project.withArchitecture(() => {}));
      const server = await (cloud ? builder.asSonarCloud() : builder).start();
      harness.withAuth(
        cloud ? server.recordedAuthServerUrl() : server.baseUrl(),
        'test-token',
        cloud ? 'my-org' : undefined,
      );
      const result = await harness.run(
        'arch directives get -p shop --id 11111111-1111-4111-8111-111111111111 --format json',
      );
      if (!cloud) {
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          'The sonar architecture command requires a SonarQube Cloud connection.',
        );
        return;
      }
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('was not found or is not accessible');
      expect(result.stderr).not.toContain('Server build');
      expect(
        server
          .getRecordedRequests()
          .filter(
            (request) =>
              ['POST', 'PATCH', 'DELETE'].includes(request.method) &&
              request.path.includes('/architecture/'),
          ),
      ).toEqual([]);
    });

    it(`keeps valid empty results and invalid input separate from compatibility on ${cloud ? 'Cloud' : 'Server'}`, async () => {
      const builder = harness
        .newFakeServer()
        .withVersion('2026.6')
        .withAuthToken('test-token')
        .withProject('shop', (project) => project.withArchitecture(() => {}));
      const server = await (cloud ? builder.asSonarCloud() : builder).start();
      harness.withAuth(
        cloud ? server.recordedAuthServerUrl() : server.baseUrl(),
        'test-token',
        cloud ? 'my-org' : undefined,
      );
      for (const target of ['current', 'intended', 'directives']) {
        const result = await harness.run(
          `arch ${target} get -p shop --format json${target === 'current' ? ' --language java' : ''}`,
        );
        if (!cloud) {
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain(
            'The sonar architecture command requires a SonarQube Cloud connection.',
          );
          return;
        }
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toBeDefined();
        expect(result.stderr + result.stdout).not.toContain(COMPATIBILITY);
      }
      const before = server
        .getRecordedRequests()
        .filter((request) => request.path.includes('/architecture/')).length;
      const invalid = await harness.run('arch current get -p shop --depth 0 --format json');
      expect(invalid.exitCode).toBe(2);
      expect(invalid.stderr).not.toContain(COMPATIBILITY);
      expect(
        server.getRecordedRequests().filter((request) => request.path.includes('/architecture/')),
      ).toHaveLength(before);
    });

    it(`preserves compatibility guidance for an unconfirmed write on ${cloud ? 'Cloud' : 'Server'} without replay`, async () => {
      const builder = harness
        .newFakeServer()
        .withVersion('2026.6')
        .withAuthToken('test-token')
        .withProject('shop', (project) =>
          project.withArchitecture((architecture) =>
            architecture.withStatus(INTENDED_RESOURCE, 201, '{}', 'POST'),
          ),
        );
      const server = await (cloud ? builder.asSonarCloud() : builder).start();
      harness.withAuth(
        cloud ? server.recordedAuthServerUrl() : server.baseUrl(),
        'test-token',
        cloud ? 'my-org' : undefined,
      );
      harness.cwd.writeFile(
        'model.json',
        JSON.stringify({
          models: [
            {
              type: 'namespace',
              language: 'java',
              groups: [{ label: 'Domain', patterns: ['app:**'] }],
              constraints: [],
            },
          ],
        }),
      );
      const result = await harness.run('arch intended set -p shop --file model.json');
      if (!cloud) {
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          'The sonar architecture command requires a SonarQube Cloud connection.',
        );
        return;
      }
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(COMPATIBILITY);
      expect(result.stderr).toContain('sonar update');
      expect(result.stderr).toContain('write could not be confirmed');
      expect(result.stderr).toContain('No automatic rollback');
      expect(
        server
          .getRecordedRequests()
          .filter(
            (request) =>
              ['POST', 'PATCH', 'DELETE'].includes(request.method) &&
              request.path.includes('/architecture/'),
          )
          .map((request) => request.method),
      ).toEqual(['POST']);
    });

    for (const status of [401, 403, 404, 500]) {
      it(`does not diagnose HTTP ${status} as version incompatibility on ${cloud ? 'Cloud' : 'Server'}`, async () => {
        const builder = harness
          .newFakeServer()
          .withVersion('2026.6')
          .withAuthToken('test-token')
          .withProject('shop', (project) =>
            project.withArchitecture((architecture) =>
              architecture.withStatus(
                'current-architectures',
                status,
                '{"message":"Request refused"}',
                'GET',
              ),
            ),
          );
        const server = await (cloud ? builder.asSonarCloud() : builder).start();
        harness.withAuth(
          cloud ? server.recordedAuthServerUrl() : server.baseUrl(),
          'test-token',
          cloud ? 'my-org' : undefined,
        );
        const result = await harness.run('arch current get -p shop --language java --format json');
        if (!cloud) {
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain(
            'The sonar architecture command requires a SonarQube Cloud connection.',
          );
          return;
        }
        expect(result.exitCode).toBe(1);
        if (status === 404 || status === 403) expect(result.stderr).toContain(COMPATIBILITY);
        else expect(result.stderr).not.toContain(COMPATIBILITY);
        if (status === 403) {
          expect(result.stderr).toContain('sonar update');
          expect(result.stderr).toContain('permission');
        } else if (status !== 404) expect(result.stderr).not.toContain('sonar update');
      });
    }
  }
});
