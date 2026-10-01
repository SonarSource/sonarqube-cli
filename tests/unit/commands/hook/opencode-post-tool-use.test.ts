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

import * as fs from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import * as clientModule from '@/commands/analyze/sqaa-analysis-client.ts';
import * as sqaaTelemetry from '@/commands/analyze/sqaa-analysis-telemetry.ts';
import {
  SQAA_HOOK_TELEMETRY_EXIT_CODE,
  SQAA_OPENCODE_POST_TOOL_USE_CALLER_COMMAND,
} from '@/commands/analyze/sqaa-analysis-telemetry.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import * as processLib from '@/core/process/process.ts';
import * as projectInfo from '@/core/project-info.ts';
import { errAsync, okAsync } from '@/core/result.ts';
import { SqaaForbiddenError } from '@/core/server/errors.ts';
import { vortexUnavailableHookMessage } from '@/core/vortex/availability-messages.ts';
import * as entitlement from '@/core/vortex/entitlement.ts';
import * as entitlementNotice from '@/core/vortex/vortex-entitlement-notice.ts';

import { opencodePostToolUse } from '../../../../src/commands/hook/opencode-post-tool-use.ts';
import * as stdinModule from '../../../../src/commands/hook/stdin.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';
import { mockAuthResolver } from '../../../_common/mock-auth-resolver.ts';

const TEST_FILE = join(process.cwd(), 'src/index.ts');

const FAKE_AUTH = new ResolvedAuth({
  token: 'tok',
  serverUrl: 'https://sonarcloud.io',
  connectionType: 'cloud',
  source: 'state' as const,
  orgKey: 'myorg',
});

const ISSUE = {
  rule: 'java:S1234',
  message: 'Fix this',
  textRange: { startLine: 10, endLine: 10, startOffset: 0, endOffset: 5 },
};

describe('opencodePostToolUse', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let readStdinJsonSpy: ReturnType<typeof spyOn>;
  let existsSyncSpy: ReturnType<typeof spyOn>;
  let readFileSyncSpy: ReturnType<typeof spyOn>;
  let createAnalysisSpy: ReturnType<typeof spyOn>;
  let recordTelemetrySpy: ReturnType<typeof spyOn>;
  let spawnProcessSpy: ReturnType<typeof spyOn>;
  let discoverProjectSpy: ReturnType<typeof spyOn>;
  let ctx: CommandInvocationContext;

  function writtenResult(): Record<string, unknown> {
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    return JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim()) as Record<string, unknown>;
  }

  beforeEach(() => {
    spawnProcessSpy = spyOn(processLib, 'spawnProcess').mockImplementation(
      (_cmd: string, args: string[]) => {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
          return Promise.resolve({ exitCode: 0, stdout: `${process.cwd()}\n`, stderr: '' });
        }
        if (args[0] === 'branch' && args[1] === '--show-current') {
          return Promise.resolve({ exitCode: 0, stdout: 'feature/hook-branch\n', stderr: '' });
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
    );
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const mocked = mockAuthResolver(FAKE_AUTH);
    resolveAuthSpy = mocked.resolveAuthSpy;
    ctx = new CommandInvocationContext(new FakeConsole(), undefined, mocked.runtime);
    readStdinJsonSpy = spyOn(stdinModule, 'readStdinJson').mockResolvedValue({
      tool: 'edit',
      filePath: TEST_FILE,
      sessionID: 'ses_1',
    });
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
    readFileSyncSpy = spyOn(fs, 'readFileSync').mockReturnValue('const x = 1;');
    discoverProjectSpy = spyOn(projectInfo, 'discoverProject').mockResolvedValue({
      repoRoot: process.cwd(),
      projectRoot: process.cwd(),
      projectKey: 'my-project',
      configSources: [],
    });
    createAnalysisSpy = spyOn(
      clientModule.SqaaAnalysisClient.prototype,
      'createAnalysis',
    ).mockResolvedValue({ id: 'analysis-id', issues: [], errors: null });
    recordTelemetrySpy = spyOn(sqaaTelemetry, 'recordSqaaAnalysisTelemetry').mockImplementation(
      () => {},
    );
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    resolveAuthSpy.mockRestore();
    readStdinJsonSpy.mockRestore();
    existsSyncSpy.mockRestore();
    readFileSyncSpy.mockRestore();
    createAnalysisSpy.mockRestore();
    recordTelemetrySpy.mockRestore();
    spawnProcessSpy.mockRestore();
    discoverProjectSpy.mockRestore();
  });

  it('writes the analysis summary as context when no issues are found', async () => {
    await opencodePostToolUse(ctx);

    expect(writtenResult().context).toContain('No issues found');
  });

  it('includes issue details in the context when issues are found', async () => {
    createAnalysisSpy.mockResolvedValue({ id: 'analysis-id', issues: [ISSUE], errors: null });

    await opencodePostToolUse(ctx);

    const { context } = writtenResult() as { context: string };
    expect(context).toContain('Fix this');
    expect(context).toContain('java:S1234');
  });

  it('includes analysis errors in the context', async () => {
    createAnalysisSpy.mockResolvedValue({
      id: 'analysis-id',
      issues: [],
      errors: [{ code: 'FILE_NOT_FOUND', message: 'File not indexed' }],
    });

    await opencodePostToolUse(ctx);

    const { context } = writtenResult() as { context: string };
    expect(context).toContain('FILE_NOT_FOUND');
    expect(context).toContain('File not indexed');
  });

  it('analyzes the file with auto-detected branch and the STANDARD single-file request', async () => {
    await opencodePostToolUse(ctx);

    expect(createAnalysisSpy).toHaveBeenCalledWith({
      organizationKey: 'myorg',
      projectKey: 'my-project',
      files: [{ path: 'src/index.ts', content: 'const x = 1;' }],
      branchName: 'feature/hook-branch',
    });
  });

  it('triggers analysis when the tool is write', async () => {
    readStdinJsonSpy.mockResolvedValue({ tool: 'write', filePath: TEST_FILE });

    await opencodePostToolUse(ctx);

    expect(createAnalysisSpy).toHaveBeenCalledTimes(1);
  });

  it('returns the session id from the payload', async () => {
    const result = await opencodePostToolUse(ctx);

    expect(result.agentSessionId).toBe('ses_1');
  });

  it('records hook telemetry with the OpenCode caller command and exit code 0', async () => {
    createAnalysisSpy.mockResolvedValue({ id: 'analysis-id', issues: [ISSUE], errors: null });

    await opencodePostToolUse(ctx);

    expect(recordTelemetrySpy).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ connectionType: 'cloud', orgKey: 'myorg' }),
      SQAA_OPENCODE_POST_TOOL_USE_CALLER_COMMAND,
      expect.objectContaining({ totalIssues: 1, totalFailures: 0 }),
      expect.any(Number),
      SQAA_HOOK_TELEMETRY_EXIT_CODE,
    );
  });

  it('runs analysis on a Server connection without an organization', async () => {
    resolveAuthSpy.mockReturnValue(
      okAsync(
        new ResolvedAuth({
          token: 'tok',
          serverUrl: 'https://sonar.example.com',
          connectionType: 'on-premise',
          source: 'state' as const,
        }),
      ),
    );

    await opencodePostToolUse(ctx);

    expect(createAnalysisSpy).toHaveBeenCalledWith({
      projectKey: 'my-project',
      files: [{ path: 'src/index.ts', content: 'const x = 1;' }],
      branchName: 'feature/hook-branch',
    });
  });

  describe('writes an empty result without analyzing', () => {
    it('when the tool is not edit or write', async () => {
      readStdinJsonSpy.mockResolvedValue({ tool: 'read', filePath: TEST_FILE });

      await opencodePostToolUse(ctx);

      expect(createAnalysisSpy).not.toHaveBeenCalled();
      expect(writtenResult()).toEqual({});
    });

    it('when filePath is missing from the payload', async () => {
      readStdinJsonSpy.mockResolvedValue({ tool: 'edit' });

      await opencodePostToolUse(ctx);

      expect(createAnalysisSpy).not.toHaveBeenCalled();
      expect(writtenResult()).toEqual({});
    });

    it('when the file does not exist', async () => {
      existsSyncSpy.mockReturnValue(false);

      await opencodePostToolUse(ctx);

      expect(createAnalysisSpy).not.toHaveBeenCalled();
      expect(writtenResult()).toEqual({});
    });

    it('when stdin is unparseable', async () => {
      readStdinJsonSpy.mockRejectedValue(new Error('Failed to parse stdin as JSON'));

      const result = await opencodePostToolUse(ctx);

      expect(createAnalysisSpy).not.toHaveBeenCalled();
      expect(writtenResult()).toEqual({});
      expect(result.agentSessionId).toBeNull();
    });

    it('when auth is unavailable', async () => {
      resolveAuthSpy.mockReturnValue(okAsync(null));

      await opencodePostToolUse(ctx);

      expect(createAnalysisSpy).not.toHaveBeenCalled();
      expect(writtenResult()).toEqual({});
    });

    it('when auth resolution fails', async () => {
      resolveAuthSpy.mockReturnValue(errAsync(new Error('keychain error')));

      await opencodePostToolUse(ctx);

      expect(createAnalysisSpy).not.toHaveBeenCalled();
      expect(writtenResult()).toEqual({});
    });

    it('when cloud auth has no orgKey', async () => {
      resolveAuthSpy.mockReturnValue(
        okAsync(
          new ResolvedAuth({
            token: 'tok',
            serverUrl: 'https://sonarcloud.io',
            connectionType: 'cloud',
            source: 'state' as const,
          }),
        ),
      );

      await opencodePostToolUse(ctx);

      expect(createAnalysisSpy).not.toHaveBeenCalled();
      expect(writtenResult()).toEqual({});
    });

    it('when no project key can be discovered', async () => {
      discoverProjectSpy.mockResolvedValue({
        repoRoot: process.cwd(),
        projectRoot: process.cwd(),
        projectKey: undefined,
        configSources: [],
      });

      await opencodePostToolUse(ctx);

      expect(createAnalysisSpy).not.toHaveBeenCalled();
      expect(writtenResult()).toEqual({});
    });
  });

  describe('when the server answers 403', () => {
    let noticeDueSpy: ReturnType<typeof spyOn>;
    let recheckSpy: ReturnType<typeof spyOn>;
    let recordWarnedSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      createAnalysisSpy.mockRejectedValue(new SqaaForbiddenError());
      noticeDueSpy = spyOn(entitlementNotice, 'isVortexEntitlementLossNoticeDue').mockReturnValue(
        true,
      );
      recheckSpy = spyOn(entitlement, 'recheckVortexEntitlement').mockResolvedValue('not_entitled');
      recordWarnedSpy = spyOn(
        entitlementNotice,
        'recordVortexEntitlementLossWarned',
      ).mockImplementation(() => {});
    });

    afterEach(() => {
      noticeDueSpy.mockRestore();
      recheckSpy.mockRestore();
      recordWarnedSpy.mockRestore();
    });

    it('writes the not-entitled notice as context and starts the cooldown', async () => {
      await opencodePostToolUse(ctx);

      expect(writtenResult()).toEqual({ context: vortexUnavailableHookMessage('not_entitled') });
      expect(recordWarnedSpy).toHaveBeenCalledTimes(1);
    });

    it('writes the over-consumption notice without starting the cooldown', async () => {
      recheckSpy.mockResolvedValue('over_consumption');

      await opencodePostToolUse(ctx);

      expect(writtenResult()).toEqual({
        context: vortexUnavailableHookMessage('over_consumption'),
      });
      expect(recordWarnedSpy).not.toHaveBeenCalled();
    });

    it('stays silent and skips the re-check while the cooldown is active', async () => {
      noticeDueSpy.mockReturnValue(false);

      await opencodePostToolUse(ctx);

      expect(writtenResult()).toEqual({});
      expect(recheckSpy).not.toHaveBeenCalled();
    });

    it.each(['enabled', 'check_failed'] as const)(
      'stays silent when the re-check cannot attribute the 403 (%s)',
      async (status) => {
        recheckSpy.mockResolvedValue(status);

        await opencodePostToolUse(ctx);

        expect(writtenResult()).toEqual({});
        expect(recordWarnedSpy).not.toHaveBeenCalled();
      },
    );
  });

  describe('fails open with an empty result and failure telemetry', () => {
    it('when the analysis request throws', async () => {
      createAnalysisSpy.mockRejectedValue(new Error('Network error'));

      await opencodePostToolUse(ctx);

      expect(writtenResult()).toEqual({});
      expect(recordTelemetrySpy).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({ connectionType: 'cloud', orgKey: 'myorg' }),
        SQAA_OPENCODE_POST_TOOL_USE_CALLER_COMMAND,
        expect.objectContaining({ totalIssues: 0, totalFailures: 1 }),
        expect.any(Number),
        SQAA_HOOK_TELEMETRY_EXIT_CODE,
      );
    });

    it('when reading the file throws', async () => {
      readFileSyncSpy.mockImplementation(() => {
        throw new Error('EACCES');
      });

      await opencodePostToolUse(ctx);

      expect(createAnalysisSpy).not.toHaveBeenCalled();
      expect(writtenResult()).toEqual({});
      expect(recordTelemetrySpy).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({ connectionType: 'cloud', orgKey: 'myorg' }),
        SQAA_OPENCODE_POST_TOOL_USE_CALLER_COMMAND,
        expect.objectContaining({ totalIssues: 0, totalFailures: 1 }),
        expect.any(Number),
        SQAA_HOOK_TELEMETRY_EXIT_CODE,
      );
    });
  });
});
