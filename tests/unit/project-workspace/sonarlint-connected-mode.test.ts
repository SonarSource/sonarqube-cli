/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SONARCLOUD_URL, SONARCLOUD_US_URL } from '../../../src/lib/config-constants';
import { loadSonarLintConfig } from '../../../src/lib/project-workspace';

function tempProject(name: string): string {
  return join(tmpdir(), `sonarlint-ut-${name}-${Date.now()}`);
}

describe('loadSonarLintConfig', () => {
  it('resolves ConnectedMode.json filename casing (SonarLint connected mode file)', async () => {
    const root = tempProject('sq');
    const sl = join(root, '.sonarlint');
    mkdirSync(sl, { recursive: true });
    writeFileSync(
      join(sl, 'ConnectedMode.json'),
      JSON.stringify({
        sonarQubeUri: 'https://sonarqube.example.com',
        projectKey: 'example_project',
      }),
    );

    try {
      const loaded = await loadSonarLintConfig(root);
      expect(loaded?.relativePath).toBe(join('.sonarlint', 'ConnectedMode.json'));
      expect(loaded?.config).toMatchObject({
        serverURL: 'https://sonarqube.example.com',
        projectKey: 'example_project',
      });
      expect(loaded?.config.organization).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads Cloud binding; EU and US regions map to the right base URL', async () => {
    for (const { region, url } of [
      { region: 'EU', url: SONARCLOUD_URL },
      { region: 'US', url: SONARCLOUD_US_URL },
    ]) {
      const root = tempProject(`sqc-${region}`);
      mkdirSync(join(root, '.sonarlint'), { recursive: true });
      writeFileSync(
        join(root, '.sonarlint', 'connectedMode.json'),
        JSON.stringify({
          sonarCloudOrganization: 'my-org',
          projectKey: 'org_project',
          region,
        }),
      );

      try {
        const loaded = await loadSonarLintConfig(root);
        expect(loaded?.config.serverURL).toBe(url);
        expect(loaded?.config.organization).toBe('my-org');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('matches binding property names case-insensitively', async () => {
    const root = tempProject('ci-server');
    const sl = join(root, '.sonarlint');
    mkdirSync(sl, { recursive: true });
    writeFileSync(
      join(sl, 'MySolution.json'),
      JSON.stringify({
        SONARQUBEURI: 'https://sonarqube.ci.example',
        pRoJeCtKeY: 'ci_server_key',
      }),
    );

    try {
      const loaded = await loadSonarLintConfig(root);
      expect(loaded?.config.serverURL).toBe('https://sonarqube.ci.example');
      expect(loaded?.config.projectKey).toBe('ci_server_key');
      expect(loaded?.config.organization).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const rootCloud = tempProject('ci-cloud');
    const slCloud = join(rootCloud, '.sonarlint');
    mkdirSync(slCloud, { recursive: true });
    writeFileSync(
      join(slCloud, 'CloudSolution.json'),
      JSON.stringify({
        SonarCloudOrganization: 'ci-org',
        PROJECTKEY: 'ci_cloud_key',
        REGION: 'US',
      }),
    );

    try {
      const loaded = await loadSonarLintConfig(rootCloud);
      expect(loaded?.config.serverURL).toBe(SONARCLOUD_US_URL);
      expect(loaded?.config.organization).toBe('ci-org');
      expect(loaded?.config.projectKey).toBe('ci_cloud_key');
    } finally {
      rmSync(rootCloud, { recursive: true, force: true });
    }
  });

  it('uses connectedMode.json first, then another *.json', async () => {
    const root = tempProject('order');
    const sl = join(root, '.sonarlint');
    mkdirSync(sl, { recursive: true });
    writeFileSync(join(sl, 'connectedMode.json'), '{ not valid json ]');
    writeFileSync(
      join(sl, 'MySolution.json'),
      JSON.stringify({ sonarCloudOrganization: 'acme', projectKey: 'acme_solution' }),
    );

    try {
      const loaded = await loadSonarLintConfig(root);
      expect(loaded?.relativePath).toBe(join('.sonarlint', 'MySolution.json'));
      expect(loaded?.config.projectKey).toBe('acme_solution');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when no json yields a binding', async () => {
    const root = tempProject('allbad');
    mkdirSync(join(root, '.sonarlint'), { recursive: true });
    writeFileSync(join(root, '.sonarlint', 'connectedMode.json'), '{}');
    writeFileSync(join(root, '.sonarlint', 'Other.json'), '{}');

    try {
      expect(await loadSonarLintConfig(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null for unusable connectedMode.json contents', async () => {
    const samples = [
      '{}',
      JSON.stringify({ unknownField: 'x' }),
      JSON.stringify({ sonarQubeUri: 'https://example.com' }),
      JSON.stringify({ sonarCloudOrganization: 'only-org' }),
      JSON.stringify({ sonarQubeUri: 'https://x', projectKey: 1 }),
      '{ not valid json ]',
    ];

    for (const [i, s] of samples.entries()) {
      const root = tempProject(`bad-${i}`);
      mkdirSync(join(root, '.sonarlint'), { recursive: true });
      writeFileSync(join(root, '.sonarlint', 'connectedMode.json'), s);

      try {
        expect(await loadSonarLintConfig(root)).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('returns null when .sonarlint is absent', async () => {
    const root = tempProject('nosonarlint');
    mkdirSync(root, { recursive: true });

    try {
      expect(await loadSonarLintConfig(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('on Unix: broken symlink to connectedMode.json is skipped; Backup.json wins', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const root = tempProject('symlink');
    const sl = join(root, '.sonarlint');
    mkdirSync(sl, { recursive: true });
    symlinkSync(join(sl, '__missing__.json'), join(sl, 'connectedMode.json'));
    writeFileSync(
      join(sl, 'Backup.json'),
      JSON.stringify({ sonarCloudOrganization: 'acme', projectKey: 'from_backup' }),
    );

    try {
      const loaded = await loadSonarLintConfig(root);
      expect(loaded?.relativePath).toBe(join('.sonarlint', 'Backup.json'));
      expect(loaded?.config.projectKey).toBe('from_backup');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('on Unix: rejects when .sonarlint is a file', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const root = tempProject('file');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.sonarlint'), 'x');

    try {
      let caught: unknown;
      try {
        await loadSonarLintConfig(root);
      } catch (e) {
        caught = e;
      }
      expect(caught).toMatchObject({ code: 'ENOTDIR' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('on Unix: non-ENOENT read failure propagates', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const root = tempProject('chmod');
    const sl = join(root, '.sonarlint');
    mkdirSync(sl, { recursive: true });
    const f = join(sl, 'connectedMode.json');
    writeFileSync(f, JSON.stringify({ sonarCloudOrganization: 'o', projectKey: 'k' }));
    chmodSync(f, 0o000);

    try {
      let caught: unknown;
      try {
        await loadSonarLintConfig(root);
      } catch (e) {
        caught = e;
      }
      const code = (caught as NodeJS.ErrnoException | undefined)?.code;
      expect(code === 'EACCES' || code === 'EPERM').toBe(true);
    } finally {
      try {
        chmodSync(f, 0o644);
      } catch {
        /* ignore */
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
