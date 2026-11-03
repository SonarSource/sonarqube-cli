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

import { TestHarness } from '../../harness';

const COMPATIBILITY = 'supported public Architecture API contract';

describe('Architecture API compatibility diagnostics', () => {
  let harness: TestHarness;
  beforeEach(async () => {
    harness = await TestHarness.create();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  for (const cloud of [false, true]) {
    for (const target of ['current', 'intended', 'directives'] as const) {
      it(`explains an incompatible ${target} envelope on ${cloud ? 'Cloud' : 'Server'} without writing`, async () => {
        const builder = harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withProject('shop', (project) =>
            project.withArchitecture((architecture) =>
              architecture.withStatus(
                target === 'current'
                  ? 'current-architectures'
                  : target === 'intended'
                    ? 'intended-architectures'
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
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(COMPATIBILITY);
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
        expect(result.exitCode).toBe(1);
        if (compatibleShape) expect(result.stderr).not.toContain(COMPATIBILITY);
        else expect(result.stderr).toContain(COMPATIBILITY);
      }
    });

    it(`keeps valid empty results and invalid input separate from compatibility on ${cloud ? 'Cloud' : 'Server'}`, async () => {
      const builder = harness
        .newFakeServer()
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
        .withAuthToken('test-token')
        .withProject('shop', (project) =>
          project.withArchitecture((architecture) =>
            architecture.withStatus('intended-architectures', 201, '{}', 'POST'),
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
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(COMPATIBILITY);
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
        expect(result.exitCode).toBe(1);
        expect(result.stderr).not.toContain(COMPATIBILITY);
      });
    }
  }
});
