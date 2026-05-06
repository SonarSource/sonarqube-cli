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
import type { SpawnResult } from '../../../../lib/process.ts';
import { type ScaScannerSpawnerLike } from './sca-scanner-spawner.ts';

export class MockScaScannerSpawner implements ScaScannerSpawnerLike {
  spawn(): Promise<SpawnResult> {
    return Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({
        releases: [
          {
            key: 'release-lodash-4.17.20',
            packageUrl: 'pkg:npm/lodash@4.17.20',
            packageManager: 'npm',
            packageName: 'lodash',
            version: '4.17.20',
            licenseExpression: 'MIT',
            known: true,
            knownPackage: true,
            newlyIntroduced: false,
            issues: [
              {
                key: 'issue-lodash-cve-2021-23337',
                severity: 'HIGH',
                type: 'VULNERABILITY',
                quality: 'SECURITY',
                status: 'CONFIRM',
                vulnerabilityId: 'CVE-2021-23337',
                cweIds: ['CWE-78'],
                cvssScore: '7.2',
                versionOptions: [
                  {
                    version: '4.17.20',
                    vulnerabilityIds: ['CVE-2021-23337'],
                    prerelease: false,
                    fixLevel: 'NONE',
                    descriptionCode: 'VERSION_IN_USE',
                  },
                  {
                    version: '4.17.21',
                    vulnerabilityIds: [],
                    prerelease: false,
                    fixLevel: 'COMPLETE',
                    descriptionCode: 'NEAREST_COMPLETE',
                  },
                  {
                    version: '4.17.21',
                    vulnerabilityIds: [],
                    prerelease: false,
                    fixLevel: 'COMPLETE',
                    descriptionCode: 'LATEST_STABLE',
                  },
                ],
              },
            ],
            dependencyFilePaths: ['package-lock.json'],
            dependencyChains: [['pkg:npm/react-scripts@5.0.1', 'pkg:npm/lodash@4.17.20']],
          },
          {
            key: 'release-requests-2.31.0',
            packageUrl: 'pkg:pypi/requests@2.31.0',
            packageManager: 'pypi',
            packageName: 'requests',
            version: '2.31.0',
            licenseExpression: 'Apache-2.0',
            known: true,
            knownPackage: true,
            newlyIntroduced: false,
            issues: [],
            dependencyFilePaths: ['requirements.txt'],
            dependencyChains: [['pkg:pypi/requests@2.31.0']],
          },
          {
            key: 'release-evil-package-0.0.1',
            packageUrl: 'pkg:npm/evil-package@0.0.1',
            packageManager: 'npm',
            packageName: 'evil-package',
            version: '0.0.1',
            licenseExpression: null,
            known: true,
            knownPackage: true,
            newlyIntroduced: true,
            issues: [
              {
                key: 'issue-evil-package-malware',
                severity: 'BLOCKER',
                type: 'MALWARE',
                quality: 'SECURITY',
                status: 'OPEN',
              },
            ],
            dependencyFilePaths: ['package-lock.json'],
            dependencyChains: [['pkg:npm/evil-package@0.0.1']],
          },
          {
            key: 'release-gpl-lib-3.0.0',
            packageUrl: 'pkg:maven/org.gnu/gpl-lib@3.0.0',
            packageManager: 'maven',
            packageName: 'org.gnu/gpl-lib',
            version: '3.0.0',
            licenseExpression: 'GPL-3.0',
            known: true,
            knownPackage: true,
            newlyIntroduced: false,
            issues: [
              {
                key: 'issue-gpl-lib-license',
                severity: 'HIGH',
                type: 'PROHIBITED_LICENSE',
                quality: 'MAINTAINABILITY',
                status: 'ACCEPT',
                spdxLicenseId: 'GPL-3.0',
              },
            ],
            dependencyFilePaths: ['pom.xml'],
            dependencyChains: [['pkg:maven/org.gnu/gpl-lib@3.0.0']],
          },
          {
            key: 'release-express-4.17.1',
            packageUrl: 'pkg:npm/express@4.17.1',
            packageManager: 'npm',
            packageName: 'express',
            version: '4.17.1',
            licenseExpression: 'MIT',
            known: true,
            knownPackage: true,
            newlyIntroduced: false,
            issues: [
              {
                key: 'issue-express-cve-2022-24999',
                severity: 'HIGH',
                type: 'VULNERABILITY',
                quality: 'SECURITY',
                status: 'OPEN',
                vulnerabilityId: 'CVE-2022-24999',
                cweIds: ['CWE-1321'],
                cvssScore: '7.5',
                versionOptions: [
                  {
                    version: '4.17.1',
                    vulnerabilityIds: ['CVE-2022-24999', 'CVE-2024-29041'],
                    prerelease: false,
                    fixLevel: 'NONE',
                    descriptionCode: 'VERSION_IN_USE',
                  },
                  {
                    version: '4.17.3',
                    vulnerabilityIds: ['CVE-2024-29041'],
                    prerelease: false,
                    fixLevel: 'PARTIAL',
                    descriptionCode: 'NEAREST_PARTIAL',
                  },
                  {
                    version: '4.19.2',
                    vulnerabilityIds: [],
                    prerelease: false,
                    fixLevel: 'COMPLETE',
                    descriptionCode: 'LATEST_STABLE',
                  },
                ],
              },
              {
                key: 'issue-express-cve-2024-29041',
                severity: 'MEDIUM',
                type: 'VULNERABILITY',
                quality: 'SECURITY',
                status: 'SAFE',
                vulnerabilityId: 'CVE-2024-29041',
                cweIds: ['CWE-601'],
                cvssScore: '6.1',
                versionOptions: [
                  {
                    version: '4.17.1',
                    vulnerabilityIds: ['CVE-2022-24999', 'CVE-2024-29041'],
                    prerelease: false,
                    fixLevel: 'NONE',
                    descriptionCode: 'VERSION_IN_USE',
                  },
                  {
                    version: '4.19.2',
                    vulnerabilityIds: [],
                    prerelease: false,
                    fixLevel: 'COMPLETE',
                    descriptionCode: 'LATEST_STABLE',
                  },
                ],
              },
            ],
            dependencyFilePaths: ['package-lock.json'],
            dependencyChains: [
              ['pkg:npm/express@4.17.1'],
              ['pkg:npm/some-server@1.0.0', 'pkg:npm/express@4.17.1'],
            ],
          },
          {
            key: 'release-rails-5.2.0',
            packageUrl: 'pkg:gem/rails@5.2.0',
            packageManager: 'gem',
            packageName: 'rails',
            version: '5.2.0',
            licenseExpression: 'MIT',
            known: true,
            knownPackage: true,
            newlyIntroduced: false,
            issues: [
              {
                key: 'issue-rails-cve-2020-8163',
                severity: 'BLOCKER',
                type: 'VULNERABILITY',
                quality: 'SECURITY',
                status: 'FIXED',
                vulnerabilityId: 'CVE-2020-8163',
                cweIds: ['CWE-94'],
                cvssScore: '9.8',
                versionOptions: [
                  {
                    version: '5.2.0',
                    vulnerabilityIds: ['CVE-2020-8163'],
                    prerelease: false,
                    fixLevel: 'NONE',
                    descriptionCode: 'VERSION_IN_USE',
                  },
                  {
                    version: '5.2.4.3',
                    vulnerabilityIds: [],
                    prerelease: false,
                    fixLevel: 'COMPLETE',
                    descriptionCode: 'NEAREST_COMPLETE',
                  },
                  {
                    version: '7.1.3',
                    vulnerabilityIds: [],
                    prerelease: false,
                    fixLevel: 'COMPLETE',
                    descriptionCode: 'LATEST_STABLE',
                  },
                ],
              },
            ],
            dependencyFilePaths: ['Gemfile.lock'],
            dependencyChains: [['pkg:gem/rails@5.2.0']],
          },
        ],
        parsedFiles: ['package-lock.json', 'requirements.txt', 'pom.xml', 'Gemfile.lock'],
        errors: [
          {
            id: 'err-1',
            code: 'MISSING_LOCKFILE',
            path: 'requirements.txt',
            message: 'Lockfile not found for requirements.txt',
          },
          {
            id: 'err-2',
            code: 'INEXACT_VERSIONS',
            path: null,
            message: 'Some dependencies use inexact version ranges',
          },
        ],
      }),
      stderr: '',
    });
  }
}
