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

// Pre-flight validation for SQAA analysis requests (before POST).

import type { SqaaAnalysisDepth, SqaaAnalysisFile, SqaaFileScope } from '../../sonarqube/client.ts';
import type { CommandFailedError } from '../_common/error.ts';
import { sqaaCommandFailedError } from './sqaa-errors.ts';

const VALID_SCOPES = new Set<SqaaFileScope>(['MAIN', 'TEST']);
const VALID_DEPTHS = new Set<SqaaAnalysisDepth>(['STANDARD', 'DEEP']);

const ABSOLUTE_PATH_PATTERN = /^([a-zA-Z]:[/\\]|\/)/;

export interface ValidateSqaaAnalysisOptions {
  analysisDepth?: SqaaAnalysisDepth;
}

export type SqaaFileValidationRejection = {
  /** Index in the original files[] array (used to map rejections back to chunk files). */
  index: number;
  file: SqaaAnalysisFile;
  error: CommandFailedError;
};

export type PartitionSqaaAnalysisFilesResult = {
  valid: SqaaAnalysisFile[];
  rejected: SqaaFileValidationRejection[];
};

function makeValidationError(message: string, remediationHint: string): CommandFailedError {
  return sqaaCommandFailedError(message, { remediationHint });
}

function relativePathValidationError(path: string): CommandFailedError | undefined {
  if (ABSOLUTE_PATH_PATTERN.test(path)) {
    return makeValidationError(
      `File path must be project-relative, not absolute: '${path}'`,
      "Use a path relative to the repository root (e.g. 'src/index.ts'), not an absolute path.",
    );
  }
  if (path.includes('\\')) {
    return makeValidationError(
      `File path must use forward slashes: '${path}'`,
      "Normalize paths to POSIX form (e.g. 'src/index.ts').",
    );
  }
  const segments = path.split('/');
  if (segments.includes('..')) {
    return makeValidationError(
      `File path must not contain '..': '${path}'`,
      'Remove parent-directory segments and use a path inside the repository.',
    );
  }
  if (segments.some((segment) => segment === '.' && path !== '.')) {
    return makeValidationError(
      `File path must not contain '.' segments: '${path}'`,
      'Use a clean project-relative path without ./ prefixes.',
    );
  }
  if (path.length === 0) {
    return makeValidationError(
      'File path must not be empty.',
      'Provide a non-empty project-relative path for each file entry.',
    );
  }
  return undefined;
}

function scopeValidationError(
  scope: SqaaFileScope | undefined,
  path: string,
): CommandFailedError | undefined {
  if (scope === undefined) {
    return undefined;
  }
  if (!VALID_SCOPES.has(scope)) {
    return makeValidationError(
      `Invalid scope '${scope}' for file '${path}'.`,
      "Use scope 'MAIN' or 'TEST' when set, or omit scope entirely.",
    );
  }
  return undefined;
}

function analysisDepthValidationError(
  analysisDepth: SqaaAnalysisDepth | undefined,
): CommandFailedError | undefined {
  if (analysisDepth === undefined) {
    return undefined;
  }
  if (!VALID_DEPTHS.has(analysisDepth)) {
    return makeValidationError(
      `Invalid analysisDepth '${analysisDepth}'.`,
      "Use analysisDepth 'STANDARD' or 'DEEP'.",
    );
  }
  return undefined;
}

function duplicatePathValidationError(path: string): CommandFailedError {
  return makeValidationError(
    `Duplicate file path in request: '${path}'`,
    'Remove duplicate entries from files[] before retrying.',
  );
}

function emptyFilesValidationError(): CommandFailedError {
  return makeValidationError(
    'files[] must contain at least one file.',
    'Include at least one file with path and content in the analysis request.',
  );
}

function validateSqaaAnalysisFile(file: SqaaAnalysisFile): CommandFailedError | undefined {
  return relativePathValidationError(file.path) ?? scopeValidationError(file.scope, file.path);
}

/**
 * Validate each file independently. Invalid entries are returned in `rejected`;
 * valid entries are posted in `valid`. Duplicate paths reject later occurrences.
 */
export function partitionSqaaAnalysisFiles(
  files: SqaaAnalysisFile[],
  options: ValidateSqaaAnalysisOptions = {},
): PartitionSqaaAnalysisFilesResult {
  const depthError = analysisDepthValidationError(options.analysisDepth);
  if (depthError) {
    throw depthError;
  }

  const valid: SqaaAnalysisFile[] = [];
  const rejected: SqaaFileValidationRejection[] = [];
  const seen = new Set<string>();

  for (const [index, file] of files.entries()) {
    const fileError = validateSqaaAnalysisFile(file);
    if (fileError) {
      rejected.push({ index, file, error: fileError });
      continue;
    }
    if (seen.has(file.path)) {
      rejected.push({ index, file, error: duplicatePathValidationError(file.path) });
      continue;
    }
    seen.add(file.path);
    valid.push(file);
  }

  return { valid, rejected };
}

/**
 * Strict validation for callers that require every file to be valid.
 * Throws {@link CommandFailedError} (exit 1) when any file fails or files[] is empty.
 */
export function validateSqaaAnalysisFiles(
  files: SqaaAnalysisFile[],
  options: ValidateSqaaAnalysisOptions = {},
): void {
  if (files.length === 0) {
    throw emptyFilesValidationError();
  }

  const { rejected } = partitionSqaaAnalysisFiles(files, options);
  if (rejected.length > 0) {
    throw rejected[0].error;
  }
}
