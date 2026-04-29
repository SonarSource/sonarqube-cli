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

import { spawnProcessWithTimeout, type SpawnResult } from '../../../../lib/process.ts';

export interface ScaScannerSpawnerLike {
  spawn(binaryPath: string, args: string[]): Promise<SpawnResult>;
}

export class DefaultScaScannerSpawner implements ScaScannerSpawnerLike {
  spawn(binaryPath: string, args: string[]): Promise<SpawnResult> {
    return spawnProcessWithTimeout(
      binaryPath,
      args,
      { stdout: 'pipe', stderr: 'pipe' },
      120000,
      'Sca timed out',
    );
  }
}

export class MockScaScannerSpawner implements ScaScannerSpawnerLike {
  spawn(): Promise<SpawnResult> {
    return Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({
        packages: [
          {
            purl: 'pkg:npm/lodash@4.17.20',
            dependencyFilePaths: ['package-lock.json'],
            dependencyChains: [['pkg:npm/react-scripts@5.0.1', 'pkg:npm/lodash@4.17.20']],
            license: { expression: 'MIT', allowed: true },
            vulnerabilities: [
              {
                id: 'CVE-2021-23337',
                cvssScore: 7.2,
                cweIds: ['CWE-78'],
                riskSeverity: 'HIGH',
                withdrawn: false,
                publishedOn: '2021-02-15T11:15:00Z',
                fixedVersions: [
                  { version: '4.17.21', fixLevel: 'safe', descriptionCode: 'upgrade_version' },
                ],
                unaffectedVersions: null,
              },
            ],
            malicious: false,
            knownPackage: true,
            knownRelease: true,
          },
          {
            purl: 'pkg:pypi/requests@2.31.0',
            dependencyFilePaths: ['requirements.txt'],
            dependencyChains: [['pkg:pypi/requests@2.31.0']],
            license: { expression: 'Apache-2.0', allowed: true },
            vulnerabilities: [],
            malicious: false,
            knownPackage: true,
            knownRelease: true,
          },
          {
            purl: 'pkg:npm/evil-package@0.0.1',
            dependencyFilePaths: ['package-lock.json'],
            dependencyChains: [['pkg:npm/evil-package@0.0.1']],
            license: { expression: 'NOASSERTION', allowed: null },
            vulnerabilities: [],
            malicious: true,
            knownPackage: true,
            knownRelease: true,
          },
          {
            purl: 'pkg:maven/org.gnu/gpl-lib@3.0.0',
            dependencyFilePaths: ['pom.xml'],
            dependencyChains: [['pkg:maven/org.gnu/gpl-lib@3.0.0']],
            license: { expression: 'GPL-3.0', allowed: false },
            vulnerabilities: [],
            malicious: false,
            knownPackage: true,
            knownRelease: true,
          },
          {
            purl: 'pkg:npm/express@4.17.1',
            dependencyFilePaths: ['package-lock.json'],
            dependencyChains: [
              ['pkg:npm/express@4.17.1'],
              ['pkg:npm/some-server@1.0.0', 'pkg:npm/express@4.17.1'],
            ],
            license: { expression: 'MIT', allowed: true },
            vulnerabilities: [
              {
                id: 'CVE-2022-24999',
                cvssScore: 7.5,
                cweIds: ['CWE-1321'],
                riskSeverity: 'HIGH',
                withdrawn: false,
                publishedOn: '2022-11-26T22:15:00Z',
                fixedVersions: [
                  { version: '4.17.3', fixLevel: 'safe', descriptionCode: 'upgrade_version' },
                ],
                unaffectedVersions: null,
              },
              {
                id: 'CVE-2024-29041',
                cvssScore: 6.1,
                cweIds: ['CWE-601'],
                riskSeverity: 'MEDIUM',
                withdrawn: false,
                publishedOn: '2024-03-25T19:15:00Z',
                fixedVersions: [
                  { version: '4.19.2', fixLevel: 'safe', descriptionCode: 'upgrade_version' },
                ],
                unaffectedVersions: null,
              },
              {
                id: 'CVE-2024-WITHDRAWN',
                cvssScore: 0.0,
                cweIds: [],
                riskSeverity: 'LOW',
                withdrawn: true,
                publishedOn: '2024-01-01T00:00:00Z',
                fixedVersions: null,
                unaffectedVersions: null,
              },
            ],
            malicious: false,
            knownPackage: true,
            knownRelease: true,
          },
          {
            purl: 'pkg:gem/rails@5.2.0',
            dependencyFilePaths: ['Gemfile.lock'],
            dependencyChains: [['pkg:gem/rails@5.2.0']],
            license: { expression: 'MIT', allowed: true },
            vulnerabilities: [
              {
                id: 'CVE-2020-8163',
                cvssScore: 9.8,
                cweIds: ['CWE-94'],
                riskSeverity: 'BLOCKER',
                withdrawn: false,
                publishedOn: '2020-07-02T19:15:00Z',
                fixedVersions: [
                  { version: '5.2.4.3', fixLevel: 'safe', descriptionCode: 'upgrade_version' },
                  { version: '6.0.3.1', fixLevel: 'safe', descriptionCode: 'upgrade_version' },
                ],
                unaffectedVersions: null,
              },
            ],
            malicious: false,
            knownPackage: true,
            knownRelease: true,
          },
        ],
        parsedFiles: ['package-lock.json', 'requirements.txt', 'pom.xml', 'Gemfile.lock'],
        errors: [],
      }),
      stderr: '',
    });
  }
}
