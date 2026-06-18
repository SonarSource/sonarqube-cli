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

/**
 * End-to-end happy path for `sonar analyze dependency-risks` against SonarQube
 * Cloud staging (EU + US) (CLI-452). Mirrors the SLCore SonarCloud ITS pattern:
 * provision a project, scan a static vulnerable npm fixture with the real
 * `sca-scanner-cli`, assert risks are reported, then tear the project down.
 *
 * Unlike the integration tests in
 * `tests/integration/specs/analyze/analyze-dependency-risks.test.ts` (real CLI
 * against an in-process fake server, which can only assert scanner *failure*),
 * this suite exercises the full real backend: download the scanner, discover
 * `package.json` / `package-lock.json`, scan against staging, and assert the
 * fixture's vulnerable dependency surfaces as dependency risks.
 *
 * Credential-gated per region: a region is SKIPPED unless its token is set
 * (`SONARCLOUD_IT_TOKEN` for EU, `SONARCLOUD_IT_TOKEN_US` for US; values in
 * 1Password under "SonarLint Core - SonarCloud ITs"). Requires the CLI binary
 * to be built first (`bun run build:binary`).
 */

import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { TestHarness } from '../../integration/harness';
import {
  createProject,
  deleteProject,
  STAGING_REGIONS,
  stagingConfig,
  uniqueProjectKey,
} from '../_common/staging';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'vulnerable-npm-project');

const SCAN_TIMEOUT_MS = 180_000;
setDefaultTimeout(SCAN_TIMEOUT_MS);

// Exit code from analyze/dependency-risks.ts: 51 = unresolved risks found.
const EXIT_UNRESOLVED_RISKS = 51;

interface DependencyRisksJson {
  project: string;
  packages: Array<{
    groups: Array<{
      type: string;
      selectedRisks: Array<{
        severity: string;
        status: string;
        vulnerabilityId: string;
      }>;
    }>;
  }>;
  summary: {
    packagesScanned: number;
    totalRisks: number;
  };
  errors: unknown[];
}

for (const region of STAGING_REGIONS) {
  const cfg = stagingConfig(region);

  describe.skipIf(!cfg.hasCredentials)(
    `analyze dependency-risks against SonarQube Cloud staging (${region}) (e2e)`,
    () => {
      let harness: TestHarness;
      let projectKey: string;

      beforeEach(async () => {
        harness = await TestHarness.create();
        mkdirSync(harness.cwd.path, { recursive: true });
        // Stage the static npm project (package.json + package-lock.json)
        cpSync(FIXTURE_DIR, harness.cwd.path, { recursive: true });

        projectKey = uniqueProjectKey('sonarqube-cli-its-sca');
        await createProject(cfg, projectKey);
      });

      afterEach(async () => {
        if (projectKey) {
          await deleteProject(cfg, projectKey).catch((err) => {
            console.warn(`[sca-staging] teardown failed for project ${projectKey}: ${err}`);
          });
        }
        await harness?.dispose();
      });

      it('reports dependency risks in json format', async () => {
        const result = await harness.run(
          `analyze dependency-risks --project ${projectKey} --format json`,
          { extraEnv: cfg.cliEnv, timeoutMs: SCAN_TIMEOUT_MS },
        );

        expect(
          result.exitCode,
          `expected exit ${EXIT_UNRESOLVED_RISKS} (unresolved risks found)\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        ).toBe(EXIT_UNRESOLVED_RISKS);

        const payload = JSON.parse(result.stdout) as DependencyRisksJson;

        expect(payload.project).toBe(projectKey);
        expect(payload.errors).toHaveLength(0);
        expect(payload.summary.packagesScanned).toBe(1);
        expect(payload.summary.totalRisks).toBe(10);

        const group = payload.packages[0].groups[0];
        expect(group.type).toBe('VULNERABILITY');
        expect(group.selectedRisks).toHaveLength(10);

        const cve = group.selectedRisks.find((r) => r.vulnerabilityId === 'CVE-2019-10744');
        expect(cve).toBeDefined();
        expect(cve!.severity).toBe('HIGH');
        expect(cve!.status).toBe('NEW');
      });

      it('reports dependency risks in toon format', async () => {
        const result = await harness.run(
          `analyze dependency-risks --project ${projectKey} --format toon`,
          { extraEnv: cfg.cliEnv, timeoutMs: SCAN_TIMEOUT_MS },
        );

        expect(
          result.exitCode,
          `expected exit ${EXIT_UNRESOLVED_RISKS} (unresolved risks found)\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        ).toBe(EXIT_UNRESOLVED_RISKS);

        expect(result.stdout).toContain(`project: ${projectKey}`);
        expect(result.stdout).toContain('totalRisks: 10');
        expect(result.stdout).toContain('packagesScanned: 1');
        expect(result.stdout).toContain('pkg:npm/lodash@4.17.4');
        expect(result.stdout).toContain('type: VULNERABILITY');
        expect(result.stdout).toContain(
          'selectedRisks[10]{severity,status,cvssScore,vulnerabilityId}:',
        );
        expect(result.stdout).toContain('HIGH,NEW,"9.1",CVE-2019-10744');
        // progress noise must not bleed into stdout
        expect(result.stdout).not.toContain('Analyzing dependency risks');
      });

      it('reports dependency risks in table format', async () => {
        const result = await harness.run(
          `analyze dependency-risks --project ${projectKey} --format table`,
          { extraEnv: cfg.cliEnv, timeoutMs: SCAN_TIMEOUT_MS },
        );

        expect(
          result.exitCode,
          `expected exit ${EXIT_UNRESOLVED_RISKS} (unresolved risks found)\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        ).toBe(EXIT_UNRESOLVED_RISKS);

        expect(result.stdout).toContain(
          '── lodash@4.17.4 [NEW] (10 risks) ──────────────────────────────────────────────',
        );
        expect(result.stdout).toContain('  HIGH      NEW      CVSS 9.1 CVE-2019-10744');
        expect(result.stdout).toContain('Summary: 1 dependencies checked, 10 risks found');
        expect(result.stdout).toContain(
          'Filtering by: new, open, confirm (discarded: accept, safe, fixed)',
        );
        expect(result.stdout).toContain(
          '  VULNERABILITY       BLOCKER ✓   0    HIGH ✗   3    MEDIUM ✗   5    LOW ✗   2    INFO ✓   0',
        );
        expect(result.stdout).toContain('  lodash@4.17.4 (10 risks, highest severity HIGH)');
        expect(result.stdout).toContain(
          '    Recommended versions without known vulnerabilities: 4.18.1 (latest stable) | 4.18.0 (nearest)',
        );
      });
    },
  );
}
