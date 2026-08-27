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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { readAnalysisEvents } from '../../_common/telemetry-helpers';
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
const HOOK_TIMEOUT_MS = 30_000;

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
      }, HOOK_TIMEOUT_MS);

      afterEach(async () => {
        if (projectKey) {
          await deleteProject(cfg, projectKey).catch((err) => {
            console.warn(`[sca-staging] teardown failed for project ${projectKey}: ${err}`);
          });
        }
        await harness?.dispose();
      }, HOOK_TIMEOUT_MS);

      it(
        'reports dependency risks in json format',
        async () => {
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
          expect(payload.summary.totalRisks).toBeGreaterThanOrEqual(10);

          const group = payload.packages[0].groups[0];
          expect(group.type).toBe('VULNERABILITY');
          expect(group.selectedRisks.length).toBeGreaterThanOrEqual(10);

          const cve = group.selectedRisks.find((r) => r.vulnerabilityId === 'CVE-2019-10744');
          expect(cve).toBeDefined();
          expect(cve!.severity).toBe('HIGH');
          expect(cve!.status).toBe('NEW');
        },
        SCAN_TIMEOUT_MS,
      );

      it(
        'reports dependency risks in toon format',
        async () => {
          const result = await harness.run(
            `analyze dependency-risks --project ${projectKey} --format toon`,
            { extraEnv: cfg.cliEnv, timeoutMs: SCAN_TIMEOUT_MS },
          );

          expect(
            result.exitCode,
            `expected exit ${EXIT_UNRESOLVED_RISKS} (unresolved risks found)\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
          ).toBe(EXIT_UNRESOLVED_RISKS);

          expect(result.stdout).toContain(`project: ${projectKey}`);
          expect(result.stdout).toContain('packagesScanned: 1');
          expect(result.stdout).toContain('pkg:npm/lodash@4.17.4');
          expect(result.stdout).toContain('type: VULNERABILITY');
          expect(result.stdout).toContain('selectedRisks[');
          expect(result.stdout).toContain('{severity,status,cvssScore,vulnerabilityId}:');
          expect(result.stdout).toContain('HIGH,NEW,"9.1",CVE-2019-10744');
          // progress noise must not bleed into stdout
          expect(result.stdout).not.toContain('Analyzing dependency risks');
        },
        SCAN_TIMEOUT_MS,
      );

      it(
        'reports dependency risks in table format',
        async () => {
          const result = await harness.run(
            `analyze dependency-risks --project ${projectKey} --format table`,
            { extraEnv: cfg.cliEnv, timeoutMs: SCAN_TIMEOUT_MS },
          );

          expect(
            result.exitCode,
            `expected exit ${EXIT_UNRESOLVED_RISKS} (unresolved risks found)\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
          ).toBe(EXIT_UNRESOLVED_RISKS);

          expect(result.stdout).toContain('── lodash@4.17.4 [NEW] (');
          expect(result.stdout).toContain('  HIGH      NEW      CVSS 9.1 CVE-2019-10744');
          expect(result.stdout).toContain('Summary: 1 dependencies checked,');
          expect(result.stdout).toContain(
            'Filtering by: new, open, confirm (discarded: accept, safe, fixed)',
          );
          expect(result.stdout).toContain('  lodash@4.17.4 (');
          expect(result.stdout).toContain('highest severity HIGH');
          expect(result.stdout).toContain('Recommended versions without known vulnerabilities:');
        },
        SCAN_TIMEOUT_MS,
      );

      it(
        'writes a single CliAnalysisCompleted with populated details to telemetry-events.ndjson',
        async () => {
          harness.state().withTelemetryEnabled();

          const result = await harness.run(
            `analyze dependency-risks --project ${projectKey} --format json`,
            // Do not set TELEMETRY_FLUSH_MODE_ENV: it no-ops commitTelemetryFacts(), so
            // CliAnalysisCompleted never lands. Egress is already off for spawned CLIs.
            {
              extraEnv: cfg.cliEnv,
              timeoutMs: SCAN_TIMEOUT_MS,
            },
          );

          expect(
            result.exitCode,
            `expected exit ${EXIT_UNRESOLVED_RISKS} (unresolved risks found)\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
          ).toBe(EXIT_UNRESOLVED_RISKS);

          const events = readAnalysisEvents(harness.sonarUserHome.path);
          expect(events.length).toBeGreaterThan(0);

          // The command also runs the secrets pre-scan, which emits its own sonar-secrets
          // event into the same file — select the SCA one by analyzer.
          const completed = events.find((e) => e.event_payload.analyzer === 'sca-scanner-cli');
          expect(completed).toBeDefined();
          if (!completed) throw new Error('expected a SCA CliAnalysisCompleted event');

          expect(completed.event_payload.analyzer).toBe('sca-scanner-cli');
          expect(completed.event_payload.caller_command).toBe('analyze dependency-risks');
          expect(completed.event_payload.failures_count).toBe(0);
          expect(completed.event_payload.exit_code).toBe(EXIT_UNRESOLVED_RISKS);
          expect(completed.event_payload.findings_count).toBeGreaterThanOrEqual(1);

          const details = JSON.parse(completed.event_payload.details) as {
            counts_by_rule: Record<string, number>;
          };
          const ruleKeys = Object.keys(details.counts_by_rule);
          expect(ruleKeys.length).toBeGreaterThanOrEqual(1);
          // Raw-enum <ScaIssueType>:<Severity> keys; the fixture's lodash CVE is a VULNERABILITY.
          expect(ruleKeys.some((k) => k.startsWith('VULNERABILITY:'))).toBe(true);
        },
        SCAN_TIMEOUT_MS,
      );
    },
  );
}
