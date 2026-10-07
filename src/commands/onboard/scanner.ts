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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { DEFAULT_ANALYSIS_TIMEOUT_SECONDS } from '@/core/commands/poll.ts';
import { scannerJavaArgs, scannerJavaPath } from '@/core/host/install/sonar-scanner.ts';
import { parseProperties } from '@/core/io/properties.ts';
import { spawnProcessWithTimeout } from '@/core/process/process.ts';
import type { Console } from '@/core/ui/console.ts';

export async function runFirstAnalysis(
  scannerHome: string,
  projectRoot: string,
  projectKey: string,
  auth: ResolvedAuth,
  directory: string,
  networkEnv: NodeJS.ProcessEnv,
  console: Console,
): Promise<string> {
  const reportPath = join(directory, 'report-task.txt');
  const args = [
    ...scannerJavaArgs(scannerHome, projectRoot),
    `-Dsonar.host.url=${auth.serverUrl}`,
    `-Dsonar.projectKey=${projectKey}`,
    `-Dsonar.projectBaseDir=${projectRoot}`,
    `-Dsonar.working.directory=${join(directory, 'work')}`,
    `-Dsonar.scanner.metadataFilePath=${reportPath}`,
    '-Dsonar.qualitygate.wait=false',
  ];
  if (auth.orgKey) args.push(`-Dsonar.organization=${auth.orgKey}`);

  console.info(`Analyzing ${projectRoot}`);
  const result = await spawnProcessWithTimeout(
    scannerJavaPath(scannerHome),
    args,
    {
      cwd: projectRoot,
      env: { ...networkEnv, SONAR_TOKEN: auth.token, SONAR_REGION: undefined },
    },
    DEFAULT_ANALYSIS_TIMEOUT_SECONDS * 1000,
    'SonarScanner analysis timed out.',
  );
  const redact = (value: string) => value.replaceAll(auth.token, '[REDACTED]');
  if (result.stdout) console.text(redact(result.stdout));
  if (result.stderr) console.text(redact(result.stderr), undefined, 'stderr');
  if (result.exitCode !== 0)
    throw new CommandFailedError(`SonarScanner exited with code ${result.exitCode ?? 'unknown'}.`);

  let report: Map<string, string>;
  try {
    report = parseProperties(readFileSync(reportPath, 'utf8'));
  } catch (cause) {
    throw new CommandFailedError('SonarScanner did not produce an analysis task report.', {
      cause,
    });
  }
  const taskId = report.get('ceTaskId');
  if (!taskId || report.get('projectKey') !== projectKey)
    throw new CommandFailedError('SonarScanner produced an invalid analysis task report.');
  return taskId;
}
