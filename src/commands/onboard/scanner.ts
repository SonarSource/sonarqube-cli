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

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { DEFAULT_ANALYSIS_TIMEOUT_SECONDS } from '@/core/commands/poll.ts';
import { LOG_DIR } from '@/core/config-constants.ts';
import {
  type ScannerInstallation,
  scannerJavaArgs,
} from '@/core/host/install/scanner-discovery.ts';
import { parseProperties } from '@/core/io/properties.ts';
import { spawnProcessWithTimeout } from '@/core/process/process.ts';
import type { Console, OutputChannel } from '@/core/ui/console.ts';

export async function runFirstAnalysis(
  scanner: ScannerInstallation,
  projectRoot: string,
  projectKey: string,
  auth: ResolvedAuth,
  directory: string,
  networkEnv: NodeJS.ProcessEnv,
  liveOutput?: { console: Console; channel: OutputChannel },
): Promise<{ taskId: string; logPath: string; stdout: string; stderr: string }> {
  const reportPath = join(directory, 'report-task.txt');
  const args = [
    ...scannerJavaArgs(scanner, projectRoot),
    `-Dsonar.host.url=${auth.serverUrl}`,
    `-Dsonar.projectKey=${projectKey}`,
    `-Dsonar.projectBaseDir=${projectRoot}`,
    `-Dsonar.working.directory=${join(directory, 'work')}`,
    `-Dsonar.scanner.metadataFilePath=${reportPath}`,
    '-Dsonar.qualitygate.wait=false',
  ];
  if (auth.orgKey) args.push(`-Dsonar.organization=${auth.orgKey}`);

  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `sonar-scanner-${randomUUID()}.log`);
  writeFileSync(logPath, `SonarScanner ${scanner.version}\nProject: ${projectKey}\n\n`, {
    mode: 0o600,
  });
  const remediationHint = `Inspect ${logPath} for scanner diagnostics, resolve the reported error, and retry the scanner.`;
  const redact = (value: string) => value.replaceAll(auth.token, '[REDACTED]');
  // Whole lines keep redaction effective when a credential spans process chunks.
  function outputLines(source: 'stdout' | 'stderr') {
    let pending = '';
    const emit = (line: string) => {
      const safe = redact(line);
      appendFileSync(logPath, `[${source}] ${safe}\n`);
      if (liveOutput) liveOutput.console.print(safe, liveOutput.channel);
    };
    return {
      write(chunk: string) {
        pending += chunk;
        for (let at = pending.indexOf('\n'); at !== -1; at = pending.indexOf('\n')) {
          emit(pending.slice(0, at).replace(/\r$/, ''));
          pending = pending.slice(at + 1);
        }
      },
      finish() {
        if (pending) emit(pending);
        pending = '';
      },
    };
  }
  const stdoutLines = outputLines('stdout');
  const stderrLines = outputLines('stderr');
  let result: Awaited<ReturnType<typeof spawnProcessWithTimeout>>;
  try {
    result = await spawnProcessWithTimeout(
      scanner.javaPath,
      args,
      {
        cwd: projectRoot,
        env: { ...networkEnv, SONAR_TOKEN: auth.token, SONAR_REGION: undefined },
        onStdout: (text) => {
          stdoutLines.write(text);
        },
        onStderr: (text) => {
          stderrLines.write(text);
        },
      },
      DEFAULT_ANALYSIS_TIMEOUT_SECONDS * 1000,
      'SonarScanner analysis timed out.',
    );
  } catch (cause) {
    const message = redact(cause instanceof Error ? cause.message : String(cause));
    appendFileSync(logPath, message + '\n');
    throw new CommandFailedError(message, { cause, remediationHint });
  } finally {
    stdoutLines.finish();
    stderrLines.finish();
  }
  const stdout = redact(result.stdout);
  const stderr = redact(result.stderr);
  if (result.exitCode !== 0)
    throw new CommandFailedError(`SonarScanner exited with code ${result.exitCode ?? 'unknown'}.`, {
      remediationHint,
    });

  let report: Map<string, string>;
  try {
    report = parseProperties(readFileSync(reportPath, 'utf8'));
  } catch (cause) {
    throw new CommandFailedError('SonarScanner did not produce an analysis task report.', {
      cause,
      remediationHint,
    });
  }
  const taskId = report.get('ceTaskId');
  if (!taskId || report.get('projectKey') !== projectKey)
    throw new CommandFailedError('SonarScanner produced an invalid analysis task report.', {
      remediationHint,
    });
  return { taskId, logPath, stdout, stderr };
}
