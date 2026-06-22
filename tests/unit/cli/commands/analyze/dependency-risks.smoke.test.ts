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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { ScaScanOrchestrator } from '../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scan-orchestrator.ts';
import type { AnalyzeProjectResponse } from '../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';
import { analyzeDependencyRisks } from '../../../../../src/cli/commands/analyze/dependency-risks.ts';
import type { ResolvedAuth } from '../../../../../src/lib/auth-resolver.ts';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../../src/ui';

const FAKE_AUTH: ResolvedAuth = {
  token: 'test-token',
  serverUrl: 'https://sonarcloud.io',
  orgKey: 'my-org',
  connectionType: 'cloud',
};

const SCAN_RESULT_STUB: AnalyzeProjectResponse = {
  releases: [
    {
      key: 'lodash:4.17.21',
      packageUrl: 'pkg:npm/lodash@4.17.21',
      packageManager: 'npm',
      packageName: 'lodash',
      version: '4.17.21',
      licenseExpression: 'MIT',
      known: true,
      knownPackage: true,
      newlyIntroduced: false,
      dependencyFilePaths: ['package-lock.json'],
      dependencyChains: [['pkg:npm/lodash@4.17.21']],
      issues: [
        {
          key: 'issue-1',
          severity: 'HIGH',
          showIncreasedSeverityWarning: null,
          type: 'VULNERABILITY',
          quality: 'SECURITY',
          status: 'ACCEPT',
          vulnerabilityId: 'CVE-2024-0001',
          cweIds: null,
          cvssScore: '7.5',
          spdxLicenseId: null,
          versionOptions: null,
        },
      ],
    },
  ],
  parsedFiles: ['package-lock.json'],
  errors: [],
};

const EXPECTED_JSON = `{
  "project": "my-project",
  "packages": [
    {
      "package": "pkg:npm/lodash@4.17.21",
      "newlyIntroduced": false,
      "riskCount": 1,
      "filePaths": [
        "package-lock.json"
      ],
      "chains": [
        {
          "parentPackage": null,
          "chains": [
            [
              "pkg:npm/lodash@4.17.21"
            ]
          ]
        }
      ],
      "groups": [
        {
          "type": "VULNERABILITY",
          "selectedRisks": [
            {
              "severity": "HIGH",
              "status": "ACCEPT",
              "cvssScore": "7.5",
              "vulnerabilityId": "CVE-2024-0001",
              "partialFixes": []
            }
          ],
          "recommendation": {
            "action": "NO_FIX_AVAILABLE",
            "fixVersions": []
          },
          "totalKnownRisksCount": 1
        }
      ]
    }
  ],
  "errors": [],
  "summary": {
    "packagesScanned": 1,
    "totalRisks": 1,
    "byType": {
      "MALWARE": {
        "BLOCKER": 0,
        "HIGH": 0,
        "MEDIUM": 0,
        "LOW": 0,
        "INFO": 0
      },
      "PROHIBITED_LICENSE": {
        "BLOCKER": 0,
        "HIGH": 0,
        "MEDIUM": 0,
        "LOW": 0,
        "INFO": 0
      },
      "VULNERABILITY": {
        "BLOCKER": 0,
        "HIGH": 1,
        "MEDIUM": 0,
        "LOW": 0,
        "INFO": 0
      }
    },
    "packages": [
      {
        "package": "pkg:npm/lodash@4.17.21",
        "riskCount": 1,
        "highestSeverity": "HIGH",
        "recommendations": {
          "VULNERABILITY": {
            "action": "NO_FIX_AVAILABLE",
            "fixVersions": []
          }
        }
      }
    ],
    "filter": {
      "effectiveStatuses": [
        "NEW",
        "OPEN",
        "CONFIRM",
        "ACCEPT",
        "SAFE",
        "FIXED"
      ],
      "discardedStatuses": []
    }
  }
}`;

const EXPECTED_TOON = `project: my-project
packages[1]:
  - package: "pkg:npm/lodash@4.17.21"
    newlyIntroduced: false
    riskCount: 1
    filePaths[1]: package-lock.json
    chains[1]{parentPackage,totalRoutes}:
      direct,1
    groups[1]:
      - type: VULNERABILITY
        selectedRisks[1]{severity,status,cvssScore,vulnerabilityId}:
          HIGH,ACCEPT,"7.5",CVE-2024-0001
        recommendation:
          action: NO_FIX_AVAILABLE
          fixVersions: []
        totalKnownRisksCount: 1
errors: []
summary:
  packagesScanned: 1
  totalRisks: 1
  byType:
    MALWARE:
      BLOCKER: 0
      HIGH: 0
      MEDIUM: 0
      LOW: 0
      INFO: 0
    PROHIBITED_LICENSE:
      BLOCKER: 0
      HIGH: 0
      MEDIUM: 0
      LOW: 0
      INFO: 0
    VULNERABILITY:
      BLOCKER: 0
      HIGH: 1
      MEDIUM: 0
      LOW: 0
      INFO: 0
  packages[1]:
    - package: "pkg:npm/lodash@4.17.21"
      riskCount: 1
      highestSeverity: HIGH
      recommendations:
        VULNERABILITY:
          action: NO_FIX_AVAILABLE
          fixVersions: []
  filter:
    effectiveStatuses[6]: NEW,OPEN,CONFIRM,ACCEPT,SAFE,FIXED
    discardedStatuses: []`;

const EXPECTED_TABLE = `── lodash@4.17.21 (1 risk) ─────────────────────────────────────────────────────
in: package-lock.json
  direct

  HIGH      ACCEPT   CVSS 7.5 CVE-2024-0001 → no fix available
  No recommended version without known vulnerabilities

════════════════════════════════════════════════════════════════════════════════

Summary: 1 dependencies checked, 1 risks found
Filtering by: new, open, confirm, accept, safe, fixed
  MALWARE             BLOCKER ✓   0    HIGH ✓   0    MEDIUM ✓   0    LOW ✓   0    INFO ✓   0
  PROHIBITED_LICENSE  BLOCKER ✓   0    HIGH ✓   0    MEDIUM ✓   0    LOW ✓   0    INFO ✓   0
  VULNERABILITY       BLOCKER ✓   0    HIGH ✗   1    MEDIUM ✓   0    LOW ✓   0    INFO ✓   0

Recommendations:
  lodash@4.17.21 (1 risk, highest severity HIGH)
    No recommended version without known vulnerabilities`;

describe('analyzeDependencyRisks - output format', () => {
  let runSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    runSpy = spyOn(ScaScanOrchestrator.prototype, 'run').mockResolvedValue(SCAN_RESULT_STUB);
  });

  afterEach(() => {
    runSpy.mockRestore();
    setMockUi(false);
    clearMockUiCalls();
  });

  function getPrinted(): string {
    const calls = getMockUiCalls().filter((c) => c.method === 'print');
    const call = calls.at(-1);
    if (!call) throw new Error('expected print() to be called');
    return call.args[0] as string;
  }

  it('serializes as JSON for --format json', async () => {
    await analyzeDependencyRisks(
      { project: 'my-project', format: 'json', statuses: 'all' },
      FAKE_AUTH,
    );

    expect(getPrinted()).toBe(EXPECTED_JSON);
  });

  it('serializes as TOON for --format toon', async () => {
    await analyzeDependencyRisks(
      { project: 'my-project', format: 'toon', statuses: 'all' },
      FAKE_AUTH,
    );

    expect(getPrinted()).toBe(EXPECTED_TOON);
  });

  it('serializes as a table for the default format', async () => {
    await analyzeDependencyRisks(
      { project: 'my-project', format: 'table', statuses: 'all' },
      FAKE_AUTH,
    );

    expect(getPrinted()).toBe(EXPECTED_TABLE);
  });
});
