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

describe('Architecture requires Cloud', () => {
  it.each(['2025.1', '2026.6', '26.11'])('blocks every operation on Server %s', async (version) => {
    const h = await TestHarness.create();
    try {
      const server = await h
        .newFakeServer()
        .withVersion(version)
        .withAuthToken('test-token')
        .start();
      h.withAuth(server.baseUrl(), 'test-token');
      for (const command of [
        'arch current get -p shop',
        'arch intended get -p shop',
        'arch intended set -p shop --file missing.json',
        'arch directives get -p shop',
        'arch directives set -p shop --file missing.json',
        'arch findings get -p shop',
        'arch install-skill',
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
  });

  it('keeps Cloud available and shows the command in help', async () => {
    const h = await TestHarness.create();
    try {
      const server = await h
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken('test-token')
        .withProject('shop', (p) => p.withArchitecture(() => undefined))
        .start();
      h.withAuth(server.recordedAuthServerUrl(), 'test-token', 'my-org');
      const help = await h.run('architecture --help');
      expect(help.stdout).toContain('SonarQube Cloud only');
      const result = await h.run('arch current get -p shop --language java --format json');
      expect(result.exitCode).toBe(0);
    } finally {
      await h.dispose();
    }
  });
});
