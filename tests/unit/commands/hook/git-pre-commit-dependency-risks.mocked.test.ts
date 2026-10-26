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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import * as scaInstall from '@/core/host/install/sca-scanner.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import {
  type CompleteProjectMapping,
  DiscoveredProjects,
} from '@/core/project-discovery/project-discovery-result.ts';
import * as projectInfo from '@/core/project-discovery/project-info.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { resetProjectUuidContextForTests } from '@/core/telemetry/project-uuid.ts';

import {
  ScaScanOrchestrator,
  type ScaScanTarget,
} from '../../../../src/commands/analyze/dependency-risk-helpers/sca-scan-orchestrator.ts';
import type {
  AnalyzeProjectResponse,
  Severity,
} from '../../../../src/commands/analyze/dependency-risk-helpers/sca-scanner.ts';
import { ScaWatchPatternsRunner } from '../../../../src/commands/analyze/dependency-risk-helpers/sca-watch-patterns.ts';
import { runDepRisksStage } from '../../../../src/commands/hook/git-pre-commit-dependency-risks.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';

const REPO = canonicalizePath(process.cwd());

function project(projectKey: string, path: string): CompleteProjectMapping {
  return {
    projectKey,
    projectRoot: join(REPO, path),
    serverUrl: 'https://sonarcloud.io',
    organization: 'my-org',
  };
}

let fake: FakeConsole;

function makeCtx() {
  return new CommandInvocationContext(fake);
}

const FAKE_AUTH = new ResolvedAuth({
  token: 'test-token',
  serverUrl: 'https://sonarcloud.io',
  orgKey: 'my-org',
  connectionType: 'cloud',
  source: 'state',
});

const FAKE_CONNECTION: SonarConnection = {
  auth: FAKE_AUTH,
  httpClient: new SonarHttpClient(FAKE_AUTH.serverUrl, FAKE_AUTH.token),
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

// One BLOCKER + two HIGH risks, all NEW (status null + newlyIntroduced true).
const SCAN_RESULT_MULTI_SEVERITY: AnalyzeProjectResponse = {
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
        {
          key: 'issue-2',
          severity: 'BLOCKER',
          showIncreasedSeverityWarning: null,
          type: 'VULNERABILITY',
          quality: 'SECURITY',
          status: null,
          vulnerabilityId: 'CVE-2024-0002',
          cweIds: null,
          cvssScore: '9.8',
          spdxLicenseId: null,
          versionOptions: null,
        },
        {
          key: 'issue-3',
          severity: 'HIGH',
          showIncreasedSeverityWarning: null,
          type: 'VULNERABILITY',
          quality: 'SECURITY',
          status: null,
          vulnerabilityId: 'CVE-2024-0003',
          cweIds: null,
          cvssScore: '8.1',
          spdxLicenseId: null,
          versionOptions: null,
        },
      ],
    },
  ],
  parsedFiles: ['package.json'],
  errors: [],
};

// Wraps a scanner response in the orchestrator's { response, scanDurationMs } return shape.
function asScan(response: AnalyzeProjectResponse) {
  return { response, scanDurationMs: 0 };
}

// Derives a scan result from the SCAN_RESULT_WITH_RISK template, replacing its single
// issue with one NEW VULNERABILITY issue per requested severity.
function withSeverities(...severities: Severity[]): AnalyzeProjectResponse {
  const [release] = SCAN_RESULT_WITH_RISK.releases;
  const [template] = release.issues;
  return {
    ...SCAN_RESULT_WITH_RISK,
    releases: [
      {
        ...release,
        issues: severities.map((severity, i) => ({
          ...template,
          key: `issue-${i + 1}`,
          severity,
          vulnerabilityId: `CVE-2024-${String(i + 1).padStart(4, '0')}`,
        })),
      },
    ],
  };
}

describe('runDepRisksStage', () => {
  let resolveScaScannerBinaryPathSpy: ReturnType<typeof spyOn>;
  let watchPatternsSpy: ReturnType<typeof spyOn>;
  let orchestratorRunSpy: ReturnType<typeof spyOn>;
  let discoverProjectsSpy: ReturnType<typeof spyOn>;

  function scannedTargets(): ScaScanTarget[] {
    return (orchestratorRunSpy.mock.calls as [unknown, ScaScanTarget][]).map((call) => call[1]);
  }

  beforeEach(() => {
    resetProjectUuidContextForTests();
    fake = new FakeConsole();
    discoverProjectsSpy = spyOn(projectInfo, 'discoverProjects').mockResolvedValue(
      new DiscoveredProjects(REPO, []),
    );
    resolveScaScannerBinaryPathSpy = spyOn(
      scaInstall,
      'resolveScaScannerBinaryPath',
    ).mockReturnValue('/usr/bin/sca-scanner');
    watchPatternsSpy = spyOn(ScaWatchPatternsRunner.prototype, 'run').mockResolvedValue([
      'package.json',
    ]);
    orchestratorRunSpy = spyOn(ScaScanOrchestrator.prototype, 'run').mockResolvedValue(
      asScan(SCAN_RESULT_WITH_RISK),
    );
  });

  afterEach(() => {
    discoverProjectsSpy.mockRestore();
    resolveScaScannerBinaryPathSpy.mockRestore();
    watchPatternsSpy.mockRestore();
    orchestratorRunSpy.mockRestore();
  });

  it('throws CommandFailedError with a minimal summary when risks are found', async () => {
    let thrown: unknown;
    try {
      await runDepRisksStage({
        project: 'demo',
        changedFiles: ['package.json'],
        connection: FAKE_CONNECTION,
        ctx: makeCtx(),
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(CommandFailedError);
    const err = thrown as CommandFailedError;
    expect(err.message).toBe('1 dependency risk found (1 HIGH)');
    expect(err.remediationHint).toBe(
      "Run 'sonar analyze dependency-risks -p demo' for details and fix recommendations. Bypass with 'git commit --no-verify' if risks are already reviewed.",
    );
  });

  it('reports the severity breakdown highest-first when multiple risks are found', async () => {
    orchestratorRunSpy.mockResolvedValue(asScan(SCAN_RESULT_MULTI_SEVERITY));

    let thrown: unknown;
    try {
      await runDepRisksStage({
        project: 'demo',
        changedFiles: ['package.json'],
        connection: FAKE_CONNECTION,
        ctx: makeCtx(),
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(CommandFailedError);
    expect((thrown as CommandFailedError).message).toBe(
      '3 dependency risks found (1 BLOCKER, 2 HIGH)',
    );
  });

  it('does not block when all risks are below MEDIUM severity', async () => {
    orchestratorRunSpy.mockResolvedValue(asScan(withSeverities('LOW', 'INFO')));

    await runDepRisksStage({
      project: 'demo',
      changedFiles: ['package.json'],
      connection: FAKE_CONNECTION,
      ctx: makeCtx(),
    });

    const successCall = fake.findCall('discreetSuccess', 'No dependency risks found.');
    expect(successCall).toBeDefined();
  });

  it('blocks on MEDIUM-and-above risks while excluding lower severities from the count', async () => {
    orchestratorRunSpy.mockResolvedValue(asScan(withSeverities('HIGH', 'MEDIUM', 'LOW')));

    let thrown: unknown;
    try {
      await runDepRisksStage({
        project: 'demo',
        changedFiles: ['package.json'],
        connection: FAKE_CONNECTION,
        ctx: makeCtx(),
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(CommandFailedError);
    expect((thrown as CommandFailedError).message).toBe(
      '2 dependency risks found (1 HIGH, 1 MEDIUM)',
    );
  });

  it('reports success and does not throw when the scan finds no risks', async () => {
    orchestratorRunSpy.mockResolvedValue(asScan(SCAN_RESULT_EMPTY));

    await runDepRisksStage({
      project: 'demo',
      changedFiles: ['package.json'],
      connection: FAKE_CONNECTION,
      ctx: makeCtx(),
    });

    expect(fake.calls.filter((c) => c.method === 'print')).toHaveLength(0);
    const successCall = fake.findCall('discreetSuccess', 'No dependency risks found.');
    expect(successCall).toBeDefined();
  });

  it('skips when no dependency manifests changed in the commit', async () => {
    await runDepRisksStage({
      project: 'demo',
      changedFiles: ['index.ts'],
      connection: FAKE_CONNECTION,
      ctx: makeCtx(),
    });

    expect(orchestratorRunSpy).not.toHaveBeenCalled();
    const skipCall = fake.findCall('success', 'No dependency manifests changed in this commit');
    expect(skipCall).toBeDefined();
  });

  it('scans under the discovered project key, from its root, when no -p was baked', async () => {
    discoverProjectsSpy.mockResolvedValue(
      new DiscoveredProjects(REPO, [project('discovered-key', 'app')]),
    );

    let thrown: unknown;
    try {
      await runDepRisksStage({
        project: undefined,
        changedFiles: ['package.json'],
        connection: FAKE_CONNECTION,
        ctx: makeCtx(),
      });
    } catch (e) {
      thrown = e;
    }

    expect(scannedTargets()).toEqual([
      { projectKey: 'discovered-key', baseDir: join(REPO, 'app') },
    ]);
    expect((thrown as CommandFailedError).remediationHint).toContain(
      "sonar analyze dependency-risks -p discovered-key'",
    );
  });

  it('scans a baked -p from the root of the linked project with that key', async () => {
    discoverProjectsSpy.mockResolvedValue(
      new DiscoveredProjects(REPO, [project('demo', 'services/demo')], true),
    );
    orchestratorRunSpy.mockResolvedValue(asScan(SCAN_RESULT_EMPTY));

    await runDepRisksStage({
      project: 'demo',
      changedFiles: ['package.json'],
      connection: FAKE_CONNECTION,
      ctx: makeCtx(),
    });

    expect(scannedTargets()).toEqual([
      { projectKey: 'demo', baseDir: join(REPO, 'services', 'demo') },
    ]);
  });

  it('scans a baked -p that is not linked from the current directory', async () => {
    orchestratorRunSpy.mockResolvedValue(asScan(SCAN_RESULT_EMPTY));

    await runDepRisksStage({
      project: 'demo',
      changedFiles: ['package.json'],
      connection: FAKE_CONNECTION,
      ctx: makeCtx(),
    });

    expect(scannedTargets()).toEqual([{ projectKey: 'demo', baseDir: REPO }]);
  });

  describe('with several projects linked in .sonar-config.json', () => {
    function linkProjects(...projects: CompleteProjectMapping[]) {
      discoverProjectsSpy.mockResolvedValue(new DiscoveredProjects(REPO, projects, true));
    }

    it('scans each project with a changed manifest from its root, reporting progress', async () => {
      linkProjects(project('api', 'services/api'), project('web', 'apps/web'));
      orchestratorRunSpy.mockResolvedValue(asScan(SCAN_RESULT_EMPTY));

      await runDepRisksStage({
        project: undefined,
        changedFiles: ['services/api/package.json', 'apps/web/package.json'],
        connection: FAKE_CONNECTION,
        ctx: makeCtx(),
      });

      expect(scannedTargets()).toEqual([
        { projectKey: 'api', baseDir: join(REPO, 'services', 'api') },
        { projectKey: 'web', baseDir: join(REPO, 'apps', 'web') },
      ]);
      expect(fake.findCall('info', 'Scanning dependency risks for api (1/2)')).toBeDefined();
      expect(fake.findCall('info', 'Scanning dependency risks for web (2/2)')).toBeDefined();
      expect(fake.findCall('discreetSuccess', 'No dependency risks found.')).toBeDefined();
    });

    it('scans only the projects whose manifests changed, without progress for a single one', async () => {
      linkProjects(project('api', 'services/api'), project('web', 'apps/web'));
      orchestratorRunSpy.mockResolvedValue(asScan(SCAN_RESULT_EMPTY));

      await runDepRisksStage({
        project: undefined,
        changedFiles: ['apps/web/package.json', 'services/api/index.ts'],
        connection: FAKE_CONNECTION,
        ctx: makeCtx(),
      });

      expect(scannedTargets().map(({ projectKey }) => projectKey)).toEqual(['web']);
      expect(fake.findCall('info', 'Scanning dependency risks')).toBeUndefined();
    });

    it('skips when the changed manifests are outside every linked project', async () => {
      linkProjects(project('api', 'services/api'));

      await runDepRisksStage({
        project: undefined,
        changedFiles: ['tools/package.json'],
        connection: FAKE_CONNECTION,
        ctx: makeCtx(),
      });

      expect(orchestratorRunSpy).not.toHaveBeenCalled();
      expect(
        fake.findCall('success', 'No dependency manifests changed in a linked project'),
      ).toBeDefined();
    });

    it('skips nested projects with a warning', async () => {
      linkProjects(
        project('api', 'services/api'),
        project('api-v2', 'services/api/v2'),
        project('web', 'apps/web'),
      );
      orchestratorRunSpy.mockResolvedValue(asScan(SCAN_RESULT_EMPTY));

      await runDepRisksStage({
        project: undefined,
        changedFiles: ['services/api/v2/package.json', 'apps/web/package.json'],
        connection: FAKE_CONNECTION,
        ctx: makeCtx(),
      });

      expect(scannedTargets().map(({ projectKey }) => projectKey)).toEqual(['web']);
      expect(
        fake.findCall('warn', 'Dependency-risks scan skipped for api: nested projects'),
      ).toBeDefined();
      expect(
        fake.findCall('warn', 'Dependency-risks scan skipped for api-v2: nested projects'),
      ).toBeDefined();
    });

    it('skips projects linked to a connection other than the active one', async () => {
      linkProjects(project('api', 'services/api'), {
        ...project('web', 'apps/web'),
        organization: 'other-org',
      });
      orchestratorRunSpy.mockResolvedValue(asScan(SCAN_RESULT_EMPTY));

      await runDepRisksStage({
        project: undefined,
        changedFiles: ['services/api/package.json', 'apps/web/package.json'],
        connection: FAKE_CONNECTION,
        ctx: makeCtx(),
      });

      expect(scannedTargets().map(({ projectKey }) => projectKey)).toEqual(['api']);
      expect(
        fake.findCall(
          'warn',
          'Dependency-risks scan skipped for web: it is linked to a connection',
        ),
      ).toBeDefined();
    });

    it('keeps scanning after a failed scan and blocks on the risks found in every project', async () => {
      linkProjects(
        project('api', 'services/api'),
        project('lib', 'libs/lib'),
        project('web', 'apps/web'),
      );
      orchestratorRunSpy
        .mockResolvedValueOnce(asScan(SCAN_RESULT_WITH_RISK))
        .mockRejectedValueOnce(new Error('scanner boom'))
        .mockResolvedValueOnce(asScan(SCAN_RESULT_MULTI_SEVERITY));

      let thrown: unknown;
      try {
        await runDepRisksStage({
          project: undefined,
          changedFiles: [
            'services/api/package.json',
            'libs/lib/package.json',
            'apps/web/package.json',
          ],
          connection: FAKE_CONNECTION,
          ctx: makeCtx(),
        });
      } catch (e) {
        thrown = e;
      }

      expect(fake.findCall('warn', 'Dependency-risks scan failed for lib;')).toBeDefined();
      expect(thrown).toBeInstanceOf(CommandFailedError);
      const err = thrown as CommandFailedError;
      expect(err.message).toBe('4 dependency risks found: api (1 HIGH), web (1 BLOCKER, 2 HIGH)');
      expect(err.remediationHint).toBe(
        "Run 'sonar analyze dependency-risks -p api', 'sonar analyze dependency-risks -p web' for details and fix recommendations. Bypass with 'git commit --no-verify' if risks are already reviewed.",
      );
    });
  });

  it('warns and skips when no project key resolved, but only after checking manifests changed', async () => {
    await runDepRisksStage({
      project: undefined,
      changedFiles: ['package.json'],
      connection: FAKE_CONNECTION,
      ctx: makeCtx(),
    });

    expect(orchestratorRunSpy).not.toHaveBeenCalled();
    const warnCall = fake.findCall('warn', 'no SonarQube project resolved for this repo');
    expect(warnCall).toBeDefined();
  });

  it('does not warn about a missing project key when no dependency manifests changed', async () => {
    await runDepRisksStage({
      project: undefined,
      changedFiles: ['index.ts'],
      connection: FAKE_CONNECTION,
      ctx: makeCtx(),
    });

    expect(orchestratorRunSpy).not.toHaveBeenCalled();
    const projectWarnCall = fake.findCall('warn', 'no SonarQube project resolved for this repo');
    expect(projectWarnCall).toBeUndefined();
    const skipCall = fake.findCall('success', 'No dependency manifests changed in this commit');
    expect(skipCall).toBeDefined();
  });
});
