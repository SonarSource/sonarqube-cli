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

// Integration tests for `analyze dependency-risks`: pre-flight gates
// (authentication, SCA availability, project existence) plus the happy path,
// which currently runs against the no-op scanner runner and emits an empty
// list of dependency risks. Once the real scanner is wired, the happy-path
// assertions will be expanded.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { buildLocalBinaryName } from '../../../../src/cli/commands/_common/install/sca-scanner.js';
import { DefaultScaScannerSpawner } from '../../../../src/cli/commands/analyze/dependency-risk-helpers/default-sca-scanner-spawner.js';
import type { AnalyzeProjectResponse } from '../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.js';
import { analyzeDependencyRisks } from '../../../../src/cli/commands/analyze/dependency-risks.js';
import type { ResolvedAuth } from '../../../../src/lib/auth-resolver.js';
import { detectPlatform } from '../../../../src/lib/platform-detector.js';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../src/ui/index.js';
import { TestHarness } from '../../harness';

const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const SCA_SCANNER_FAILURE_PREFIX = 'Dependency risk analysis error: sca-scanner exited with code';

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
          fixVersions[0]:
        totalKnownRisksCount: 1
errors[0]:
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
          fixVersions[0]:
  filter:
    effectiveStatuses[6]: NEW,OPEN,CONFIRM,ACCEPT,SAFE,FIXED
    discardedStatuses[0]:`;

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

describe('analyze dependency-risks', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 when not authenticated',
    async () => {
      const result = await harness.run('analyze dependency-risks --project demo');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('❌ Not authenticated.');
      expect(output).toContain("  → Run 'sonar auth login' to authenticate.");
    },
    { timeout: 15000 },
  );

  it('exits with code 1 when project does not exist (settings 404)', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withScaEnabled(true)
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

    const result = await harness.run('analyze dependency-risks --project demo');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('Project demo not found');
    expect(server.getRecordedRequests().some((r) => r.path === '/api/settings/values')).toBe(true);
  });

  it(
    'exits with code 1 when SCA is disabled on the server',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withScaEnabled(false)
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('analyze dependency-risks --project demo');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        'Software Composition Analysis is not available for the current connection.',
      );
    },
    { timeout: 15000 },
  );

  // todo: https://sonarsource.atlassian.net/browse/CLI-452 Add end-to-end tests
  // The next two tests assert on scanner *failure* because the in-process
  // fake server does not implement the SCA-scanner backend APIs. Move happy-path
  // coverage to a real-backend e2e suite (e.g. SonarQube Cloud staging) once one
  // exists.
  it('reports a scanner failure when the SCA backend is unavailable', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withScaEnabled(true)
      .withProject('demo')
      .withProjectSettings('demo', [])
      .start();
    harness.state().withScaScannerBinaryInstalled();
    harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

    const result = await harness.run('analyze dependency-risks --project demo --format json', {
      timeoutMs: 30_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(SCA_SCANNER_FAILURE_PREFIX);
  });

  it(
    'auto-installs sca-scanner-cli when binary is absent',
    async () => {
      await harness.newFakeBinariesServer().start();
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withScaEnabled(true)
        .withProject('demo')
        .withProjectSettings('demo', [])
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('analyze dependency-risks --project demo --format json');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(SCA_SCANNER_FAILURE_PREFIX);
      expect(harness.cliHome.file('bin', buildLocalBinaryName(detectPlatform())).exists()).toBe(
        true,
      );
      const state = harness.stateJsonFile.asJson() as {
        tools: { installed: Array<{ name: string; version: string }> };
      };
      const recorded = state.tools.installed.find((t) => t.name === 'sca-scanner-cli');
      expect(recorded).toBeDefined();
      expect(recorded?.version).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'aborts when sca-scanner-cli download fails',
    async () => {
      await harness.newFakeBinariesServer().noArtifacts().start();
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withScaEnabled(true)
        .withProject('demo')
        .withProjectSettings('demo', [])
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('analyze dependency-risks --project demo --format json');

      expect(result.exitCode).not.toBe(0);
      expect(harness.cliHome.file('bin', buildLocalBinaryName(detectPlatform())).exists()).toBe(
        false,
      );
    },
    { timeout: 30000 },
  );

  it('rejects an unknown --statuses value', async () => {
    harness.withAuth('http://unused.example', VALID_TOKEN, TEST_ORG);

    const result = await harness.run('analyze dependency-risks --project demo --statuses bogus');

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Invalid --statuses value: 'bogus'");
  });

  it('exits with code 1 when the SCA endpoint is absent (404)', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withVersion('26.4')
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN);

    const result = await harness.run('analyze dependency-risks --project demo');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      'Software Composition Analysis is not available for the current connection.',
    );
  });

  it('exits with code 1 when the on-premise server version is below 2026.4', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withVersion('26.3')
      .withScaEnabled(true)
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN);

    const result = await harness.run('analyze dependency-risks --project demo');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      'Running Software Composition Analysis from this CLI requires SonarQube Server 2026.4 or later (server is 26.3)',
    );
    // Version check runs before the SCA feature-enabled probe.
    expect(server.getRecordedRequests().some((r) => r.path.endsWith('/sca/feature-enabled'))).toBe(
      false,
    );
  });

  it('proceeds past the version check when the on-premise server version is 2026.4 or newer', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withVersion('2026.4.0.12345')
      .withScaEnabled(false)
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN);

    const result = await harness.run('analyze dependency-risks --project demo');

    // Version check passes — failure now comes from the SCA availability check.
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      'Software Composition Analysis is not available for the current connection.',
    );
  });

  it('exits with code 1 when the on-premise server version cannot be determined', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withSystemStatusCode(503)
      .withScaEnabled(true)
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN);

    const result = await harness.run('analyze dependency-risks --project demo');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      'Could not determine SonarQube Server version. Running Software Composition Analysis from this CLI requires SonarQube Server 2026.4 or later.',
    );
  });

  it('skips the server version check for cloud connections', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(VALID_TOKEN)
      .withVersion('1.0')
      .withScaEnabled(false)
      .start();
    harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

    const result = await harness.run('analyze dependency-risks --project demo');

    // Despite the absurdly old "version", the cloud path bypasses the check
    // and proceeds to the SCA availability probe.
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      'Software Composition Analysis is not available for the current connection.',
    );
    expect(server.getRecordedRequests().some((r) => r.path === '/api/system/status')).toBe(false);
  });

  describe('output format', () => {
    let spawnSpy: ReturnType<typeof spyOn>;
    let auth: ResolvedAuth;

    beforeEach(async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withScaEnabled(true)
        .withProject('my-project')
        .withProjectSettings('my-project', [])
        .start();
      auth = {
        token: VALID_TOKEN,
        serverUrl: server.baseUrl(),
        orgKey: TEST_ORG,
        connectionType: 'cloud',
      };

      setMockUi(true);
      spawnSpy = spyOn(DefaultScaScannerSpawner.prototype, 'spawn').mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify(SCAN_RESULT_STUB),
        stderr: '',
      });
    });

    afterEach(() => {
      spawnSpy.mockRestore();
      setMockUi(false);
      clearMockUiCalls();
    });

    function getPrinted(): string {
      const call = getMockUiCalls().find((c) => c.method === 'print');
      if (!call) throw new Error('expected print() to be called');
      return call.args[0] as string;
    }

    it('serializes as JSON for --format json', async () => {
      await analyzeDependencyRisks(
        { project: 'my-project', format: 'json', statuses: 'all' },
        auth,
      );

      expect(getPrinted()).toBe(EXPECTED_JSON);
    });

    it('serializes as TOON for --format toon', async () => {
      await analyzeDependencyRisks(
        { project: 'my-project', format: 'toon', statuses: 'all' },
        auth,
      );

      expect(getPrinted()).toBe(EXPECTED_TOON);
    });

    it('serializes as a table for the default format', async () => {
      await analyzeDependencyRisks(
        { project: 'my-project', format: 'table', statuses: 'all' },
        auth,
      );

      expect(getPrinted()).toBe(EXPECTED_TABLE);
    });
  });
});
