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

import * as sqaaModule from '../../../../../src/cli/commands/analyze/sqaa';
import { codexPostToolUse } from '../../../../../src/cli/commands/hook/codex-post-tool-use';
import * as authResolver from '../../../../../src/lib/auth-resolver';

describe('codexPostToolUse', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let buildSqaaJsonReportSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue({
      token: 'tok',
      serverUrl: 'https://sonarcloud.io',
      connectionType: 'cloud',
      orgKey: 'myorg',
    });
    buildSqaaJsonReportSpy = spyOn(sqaaModule, 'buildSqaaJsonReport').mockResolvedValue({
      files: [{ path: 'src/foo.ts', issues: [], errors: null }],
      ignored: [],
      failures: [],
      skipped: [],
      summary: { totalIssues: 0, totalFailures: 0, totalSkipped: 0 },
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    resolveAuthSpy.mockRestore();
    buildSqaaJsonReportSpy.mockRestore();
  });

  it('writes additionalContext when change-set analysis finds no issues', async () => {
    await codexPostToolUse({ project: 'my-project' });

    expect(buildSqaaJsonReportSpy).toHaveBeenCalledWith(
      { project: 'my-project', force: true, format: 'json' },
      expect.objectContaining({ connectionType: 'cloud' }),
    );
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(output.hookSpecificOutput.additionalContext).toContain('no issues');
  });

  it('surfaces per-file analysis errors when totalIssues is zero', async () => {
    buildSqaaJsonReportSpy.mockResolvedValue({
      files: [
        {
          path: 'src/foo.ts',
          issues: [],
          errors: [{ code: 'FILE_NOT_FOUND', message: 'File not indexed' }],
        },
      ],
      ignored: [],
      failures: [],
      skipped: [],
      summary: { totalIssues: 0, totalFailures: 0, totalSkipped: 0 },
    });

    await codexPostToolUse({ project: 'my-project' });

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.additionalContext).not.toContain('no issues found');
    expect(output.hookSpecificOutput.additionalContext).toContain('FILE_NOT_FOUND');
  });

  it('includes multi-file issue details in additionalContext', async () => {
    buildSqaaJsonReportSpy.mockResolvedValue({
      files: [
        {
          path: 'src/a.ts',
          issues: [
            {
              rule: 'typescript:S1234',
              message: 'Fix this',
              textRange: { startLine: 3, endLine: 3, startOffset: 0, endOffset: 1 },
            },
          ],
          errors: null,
        },
      ],
      ignored: [],
      failures: [],
      skipped: [],
      summary: { totalIssues: 1, totalFailures: 0, totalSkipped: 0 },
    });

    await codexPostToolUse({ project: 'my-project' });

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.additionalContext).toContain('Fix this');
    expect(output.hookSpecificOutput.additionalContext).toContain('typescript:S1234');
    expect(output.hookSpecificOutput.additionalContext).toContain('src/a.ts');
  });

  it('skips output when project key is missing', async () => {
    await codexPostToolUse({});

    expect(buildSqaaJsonReportSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('skips output when auth is not Cloud', async () => {
    resolveAuthSpy.mockResolvedValue({
      token: 'tok',
      serverUrl: 'https://sonar.example.com',
      connectionType: 'server',
    });

    await codexPostToolUse({ project: 'my-project' });

    expect(buildSqaaJsonReportSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('skips output on empty change set', async () => {
    buildSqaaJsonReportSpy.mockResolvedValue({
      files: [],
      ignored: [],
      failures: [],
      skipped: [],
      summary: { totalIssues: 0, totalFailures: 0, totalSkipped: 0 },
    });

    await codexPostToolUse({ project: 'my-project' });

    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('does not throw when buildSqaaJsonReport fails', async () => {
    buildSqaaJsonReportSpy.mockRejectedValue(new Error('git failed'));

    await codexPostToolUse({ project: 'my-project' });

    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('skips output when buildSqaaJsonReport returns null', async () => {
    buildSqaaJsonReportSpy.mockResolvedValue(null);

    await codexPostToolUse({ project: 'my-project' });

    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
