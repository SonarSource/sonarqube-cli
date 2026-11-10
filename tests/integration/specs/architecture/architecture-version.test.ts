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
import { describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('Architecture Server version', () => {
  it.each(['2025.1', '2026.5.4', '26.11'])(
    'rejects Architecture operations on Server %s',
    async (version) => {
      const h = await TestHarness.create();
      try {
        const server = await h
          .newFakeServer()
          .withVersion(version)
          .withAuthToken('test-token')
          .withProject('shop', (p) => p.withArchitecture(() => undefined))
          .start();
        h.withAuth(server.baseUrl(), 'test-token');
        h.cwd.writeFile('intended.json', JSON.stringify({ models: [] }));
        h.cwd.writeFile('directives.json', JSON.stringify({ create: [] }));
        for (const command of [
          'arch current get -p shop',
          'arch intended get -p shop',
          'arch intended set -p shop --file intended.json --dry-run',
          'arch directives get -p shop',
          'arch directives set -p shop --file directives.json --dry-run',
          'arch findings get -p shop',
        ]) {
          const result = await h.run(command);
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain(
            'The sonar architecture command requires a SonarQube Cloud connection.',
          );
          expect(result.stderr).toContain(
            'Authenticate against SonarQube Cloud with ‘sonar auth login’ and retry.',
          );
        }
        expect(
          server
            .getRecordedRequests()
            .filter((r) => r.path.includes('/architecture/') || r.path === '/api/system/status'),
        ).toHaveLength(0);
      } finally {
        await h.dispose();
      }
    },
  );

  it('keeps Cloud available regardless of the Server version', async () => {
    const h = await TestHarness.create();
    try {
      const server = await h
        .newFakeServer()
        .withVersion('2025.1')
        .asSonarCloud()
        .withAuthToken('test-token')
        .withProject('shop', (p) => p.withArchitecture(() => undefined))
        .start();
      h.withAuth(server.recordedAuthServerUrl(), 'test-token', 'my-org');
      const result = await h.run('arch current get -p shop --language java --format json');
      expect(result.exitCode).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  it('rejects Server without checking an unavailable version', async () => {
    const h = await TestHarness.create();
    try {
      const server = await h
        .newFakeServer()
        .withSystemStatusCode(503)
        .withAuthToken('test-token')
        .withProject('shop', (p) => p.withArchitecture(() => undefined))
        .start();
      h.withAuth(server.baseUrl(), 'test-token');
      const result = await h.run('arch current get -p shop --language java --format json');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'The sonar architecture command requires a SonarQube Cloud connection.',
      );
      expect(
        server
          .getRecordedRequests()
          .some((r) => r.path.includes('/architecture/') || r.path === '/api/system/status'),
      ).toBe(false);
    } finally {
      await h.dispose();
    }
  });

  it('rejects Server before checking an unavailable Architecture API', async () => {
    const h = await TestHarness.create();
    try {
      const server = await h
        .newFakeServer()
        .withSystemStatusCode(503)
        .withAuthToken('test-token')
        .withProject('shop', (p) =>
          p.withArchitecture((architecture) =>
            architecture.withStatus('current-architectures', 404, '{}', 'GET'),
          ),
        )
        .start();
      h.withAuth(server.baseUrl(), 'test-token');
      const result = await h.run('arch current get -p shop --language java --format json');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'The sonar architecture command requires a SonarQube Cloud connection.',
      );
      expect(
        server
          .getRecordedRequests()
          .some((r) => r.path.includes('/architecture/') || r.path === '/api/system/status'),
      ).toBe(false);
    } finally {
      await h.dispose();
    }
  });
});
