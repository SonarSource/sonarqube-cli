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

import { expect, it } from 'bun:test';

import { TestHarness } from '../../harness';
import { INTENDED_RESOURCE } from '../../harness/fake-architecture';

it.each(['current', 'intended'] as const)(
  'keeps endpoint-availability guidance for a missing public %s collection',
  async (target) => {
    const h = await TestHarness.create();
    try {
      const server = await h
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken('test-token')
        .withProject('shop', (project) =>
          project.withArchitecture((architecture) =>
            architecture.withStatus(
              target === 'current' ? 'current-architectures' : INTENDED_RESOURCE,
              404,
              '{"message":"Missing endpoint"}',
              'GET',
            ),
          ),
        )
        .start();
      h.withAuth(server.recordedAuthServerUrl(), 'test-token', 'my-org');
      const result = await h.run(
        `arch ${target} get -p shop --format json${target === 'current' ? ' --language java' : ''}`,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'The public Architecture API endpoint was not found (HTTP 404).',
      );
      expect(result.stderr).toContain('Browse permission');
      expect(result.stderr).not.toContain("Project 'shop' or its architecture was not found");
      expect(
        server
          .getRecordedRequests()
          .filter((request) => ['POST', 'PATCH', 'DELETE'].includes(request.method)),
      ).toHaveLength(0);
    } finally {
      await h.dispose();
    }
  },
);

it.each([null, {}, { currentArchitectures: null }, { currentArchitectures: {} }])(
  'adds compatibility guidance for a malformed current collection envelope (%j)',
  async (body) => {
    const h = await TestHarness.create();
    try {
      const server = await h
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken('test-token')
        .withProject('shop', (project) =>
          project.withArchitecture((architecture) =>
            architecture.withStatus('current-architectures', 200, JSON.stringify(body), 'GET'),
          ),
        )
        .start();
      h.withAuth(server.recordedAuthServerUrl(), 'test-token', 'my-org');
      const result = await h.run('arch current get -p shop --language java --format json');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('currentArchitectures must be an array');
      expect(result.stderr).toContain('support the same Architecture API');
      expect(result.stdout).toBe('');
      expect(
        server
          .getRecordedRequests()
          .filter((request) => ['POST', 'PATCH', 'DELETE'].includes(request.method)),
      ).toHaveLength(0);
    } finally {
      await h.dispose();
    }
  },
);
