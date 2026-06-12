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

import { CommandFailedError } from '../../../../../src/cli/commands/_common/error.ts';
import * as scaInstall from '../../../../../src/cli/commands/_common/install/sca-scanner.ts';
import { ScaScanOrchestrator } from '../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scan-orchestrator.ts';
import type { AnalyzeProjectResponse } from '../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';
import { ScaWatchPatternsRunner } from '../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-watch-patterns.ts';
import { runDepRisksStage } from '../../../../../src/cli/commands/hook/git-pre-commit-dependency-risks.ts';
import type { ResolvedAuth } from '../../../../../src/lib/auth-resolver.ts';
import { clearMockUiCalls, findMockUiCall, getMockUiCalls, setMockUi } from '../../../../../src/ui';

const FAKE_AUTH: ResolvedAuth = {
  token: 'test-token',
  serverUrl: 'https://sonarcloud.io',
  orgKey: 'my-org',
  connectionType: 'cloud',
};

// issue.status null + newlyIntroduced true → effectiveStatus returns 'NEW', passing the hook's 'new' filter
const SCAN_RESULT_WITH_RISK: AnalyzeProjectResponse = {
  releases: [
    {
      key: 'lodash:4.17.21',
      packageUrl: 'pkg:npm/lodash@4.17.21',
      packageManager: 'npm',
      packageName: 'lodash',
      version: '4.17.21',
      licenseExpression: null,
      known: true,
      knownPackage: true,
      newlyIntroduced: true,
      dependencyFilePaths: ['package.json'],
      dependencyChains: [['pkg:npm/lodash@4.17.21']],
      issues: [
        {
          key: 'issue-1',
          severity: 'HIGH',
          showIncreasedSeverityWarning: null,
          type: 'VULNERABILITY',
          quality: 'SECURITY',
          status: null,
          vulnerabilityId: 'CVE-2024-0001',
          cweIds: null,
          cvssScore: '7.5',
          spdxLicenseId: null,
          versionOptions: null,
        },
      ],
    },
  ],
  parsedFiles: ['package.json'],
  errors: [],
};

const SCAN_RESULT_EMPTY: AnalyzeProjectResponse = {
  releases: [],
  parsedFiles: [],
  errors: [],
};

describe('runDepRisksStage', () => {
  let resolveScaScannerBinaryPathSpy: ReturnType<typeof spyOn>;
  let watchPatternsSpy: ReturnType<typeof spyOn>;
  let orchestratorRunSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    resolveScaScannerBinaryPathSpy = spyOn(
      scaInstall,
      'resolveScaScannerBinaryPath',
    ).mockReturnValue('/usr/bin/sca-scanner');
    watchPatternsSpy = spyOn(ScaWatchPatternsRunner.prototype, 'run').mockResolvedValue([
      'package.json',
    ]);
    orchestratorRunSpy = spyOn(ScaScanOrchestrator.prototype, 'run').mockResolvedValue(
      SCAN_RESULT_WITH_RISK,
    );
  });

  afterEach(() => {
    resolveScaScannerBinaryPathSpy.mockRestore();
    watchPatternsSpy.mockRestore();
    orchestratorRunSpy.mockRestore();
    setMockUi(false);
    clearMockUiCalls();
  });

  it('prints the risk table and throws CommandFailedError when risks are found', async () => {
    let thrown: unknown;
    try {
      await runDepRisksStage({ project: 'demo', changedFiles: ['package.json'], auth: FAKE_AUTH });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(CommandFailedError);
    const err = thrown as CommandFailedError;
    expect(err.message).toBe('Dependency risks detected (1 matching the configured filter).');
    expect(err.remediationHint).toBe(
      "Run 'sonar analyze dependency-risks -p demo' to inspect & fix the risks, then retry the commit.",
    );

    const printCall = findMockUiCall('print', 'lodash@4.17.21');
    expect(printCall).toBeDefined();
  });

  it('resolves without throwing when the scan finds no risks', async () => {
    orchestratorRunSpy.mockResolvedValue(SCAN_RESULT_EMPTY);

    await runDepRisksStage({ project: 'demo', changedFiles: ['package.json'], auth: FAKE_AUTH });

    expect(getMockUiCalls().filter((c) => c.method === 'print')).toHaveLength(0);
  });

  it('skips when no dependency manifests changed in the commit', async () => {
    await runDepRisksStage({ project: 'demo', changedFiles: ['index.ts'], auth: FAKE_AUTH });

    expect(orchestratorRunSpy).not.toHaveBeenCalled();
    const skipCall = findMockUiCall('success', 'No dependency manifests changed in this commit');
    expect(skipCall).toBeDefined();
  });
});
