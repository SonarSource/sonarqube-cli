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

import type { SonarConnection } from '@/core/server/connection.ts';

import type { FileFailure } from './sqaa-analysis.ts';
import { readSqaaFileContent } from './sqaa-api.ts';
import { resolveSqaaBranch } from './sqaa-changeset.ts';
import type { SqaaDeepWireDepth } from './sqaa-depth.ts';
import type { SqaaPath } from './sqaa-paths.ts';
import type { PreparedSqaaRun, SqaaProjectFiles } from './sqaa-types.ts';
import { partitionSqaaAnalysisFiles } from './sqaa-validation.ts';
import type { SqaaAnalysisRequest } from './sqaa-wire-types.ts';

export interface PreparedSqaaProject {
  serverUrl: string;
  payload: SqaaAnalysisRequest;
  paths: SqaaPath[];
  failures: FileFailure[];
}

export interface PreparedSqaaAnalysis {
  run: PreparedSqaaRun;
  projects: PreparedSqaaProject[];
}

export function prepareSqaaProject(
  project: SqaaProjectFiles,
  connection: SonarConnection,
  branch?: string,
  analysisDepth?: SqaaDeepWireDepth,
  failOnReadError = false,
): PreparedSqaaProject {
  const failures: FileFailure[] = [];
  const readable: Array<{ path: SqaaPath; content: string }> = [];
  for (const path of project.files) {
    try {
      readable.push({ path, content: readSqaaFileContent(path.absolutePath) });
    } catch (error) {
      if (failOnReadError) throw error;
      failures.push({
        file: path.absolutePath,
        filePath: path.displayPath,
        failure: error as Error,
      });
    }
  }
  const { valid, rejected } = partitionSqaaAnalysisFiles(
    readable.map(({ path, content }) => ({ path: path.serverPath, content })),
    { analysisDepth },
  );
  for (const { index, error } of rejected) {
    const path = readable[index].path;
    failures.push({ file: path.absolutePath, filePath: path.displayPath, failure: error });
  }
  const rejectedIndices = new Set(rejected.map(({ index }) => index));
  return {
    serverUrl: connection.httpClient.baseUrl,
    payload: {
      ...(connection.auth.orgKey ? { organizationKey: connection.auth.orgKey } : {}),
      projectKey: project.projectKey,
      ...(branch ? { branchName: branch } : {}),
      ...(analysisDepth ? { analysisDepth } : {}),
      files: valid,
    },
    paths: readable
      .filter((_, index) => !rejectedIndices.has(index))
      .map(({ path }) => ({ ...path })),
    failures,
  };
}

export async function prepareSqaaRequests(run: PreparedSqaaRun): Promise<PreparedSqaaAnalysis> {
  const branch =
    run.mode === 'edited-file'
      ? await resolveSqaaBranch(undefined, run.files.projects[0].files[0].absolutePath)
      : run.branch;
  return {
    run,
    projects: run.files.projects.map((project) =>
      prepareSqaaProject(
        project,
        run.connection,
        branch,
        run.wireDepth,
        run.mode === 'single-file' || run.mode === 'edited-file',
      ),
    ),
  };
}
