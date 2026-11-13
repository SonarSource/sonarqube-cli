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

import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  cloudRegionFromUrl,
  cloudRegionToUrl,
  isSonarQubeCloud,
  resolveFromEndpoint,
} from '@/core/server/sonarcloud-region.ts';

describe('AU region', () => {
  it.each(['https://sonarqube.au', 'https://sonarqube.au/', 'https://au-sc-staging.io'])(
    'recognizes %s as SonarQube Cloud AU',
    (url) => {
      expect(cloudRegionFromUrl(url)).toBe('au');
      expect(isSonarQubeCloud(url)).toBe(true);
    },
  );

  it('does not treat http or look-alike hosts as AU staging or production', () => {
    expect(cloudRegionFromUrl('http://au-sc-staging.io')).toBeUndefined();
    expect(cloudRegionFromUrl('https://sonarqube.au.evil.com')).toBeUndefined();
    expect(isSonarQubeCloud('https://evil-sonarqube.au')).toBe(false);
  });

  it('maps every region to its own production URL', () => {
    expect(cloudRegionToUrl('eu')).toBe('https://sonarcloud.io');
    expect(cloudRegionToUrl('us')).toBe('https://sonarqube.us');
    expect(cloudRegionToUrl('au')).toBe('https://sonarqube.au');
  });

  it.each([
    ['https://sonarqube.au', 'https://sonarqube.au', 'https://api.sonarqube.au'],
    ['https://au-sc-staging.io', 'https://au-sc-staging.io', 'https://api.au-sc-staging.io'],
    ['https://sonarqube.us', 'https://sonarqube.us', 'https://api.sonarqube.us'],
    ['https://sonarcloud.io', 'https://sonarcloud.io', 'https://api.sonarcloud.io'],
  ])('routes %s: /api to the web host, the rest to the API host', (url, web, api) => {
    expect(resolveFromEndpoint(url, '/api/projects/search')).toBe(web);
    expect(resolveFromEndpoint(url, '/organizations')).toBe(api);
  });
});

describe('AU override environment variables', () => {
  const constantsPath = join(import.meta.dir, '../../../../src/core/config-constants.ts');

  function readConstants(env: Record<string, string>): Record<string, string> {
    // Constants are read once at module load, so a fresh process is needed.
    const script = `import * as c from ${JSON.stringify(constantsPath)};
      console.log(JSON.stringify({ url: c.SONARCLOUD_AU_URL, api: c.SONARCLOUD_AU_API_URL, host: c.SONARCLOUD_AU_HOSTNAME }));`;
    const proc = Bun.spawnSync([process.execPath, '-e', script], {
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    expect(proc.exitCode).toBe(0);
    return JSON.parse(proc.stdout.toString()) as Record<string, string>;
  }

  it('defaults to the production AU hosts', () => {
    expect(readConstants({})).toEqual({
      url: 'https://sonarqube.au',
      api: 'https://api.sonarqube.au',
      host: 'sonarqube.au',
    });
  });

  it('honors SONARQUBE_CLI_SONARCLOUD_AU_URL and SONARQUBE_CLI_SONARCLOUD_AU_API_URL', () => {
    expect(
      readConstants({
        SONARQUBE_CLI_SONARCLOUD_AU_URL: 'http://127.0.0.1:9000',
        SONARQUBE_CLI_SONARCLOUD_AU_API_URL: 'http://127.0.0.1:9001',
      }),
    ).toEqual({ url: 'http://127.0.0.1:9000', api: 'http://127.0.0.1:9001', host: '127.0.0.1' });
  });
});
