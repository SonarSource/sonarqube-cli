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
        await deleteProject(cfg, projectKey).catch((err) => {
          // Best-effort teardown
          console.warn(`[sca-staging] teardown failed for project ${projectKey}: ${err}`);
        });
        await harness.dispose();
      });

      it('reports dependency risks for a vulnerable npm package', async () => {
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
        expect(payload.summary.packagesScanned).toBeGreaterThan(0);
        expect(payload.summary.totalRisks).toBeGreaterThan(0);
      });
    },
  );
}
