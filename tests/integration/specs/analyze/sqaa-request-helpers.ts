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

import type { RecordedRequest } from '../../harness';

export interface ParsedSqaaRequestBody {
  organizationKey?: string;
  projectKey?: string;
  branchName?: string;
  analysisDepth?: string;
  files?: Array<{ path: string; content: string }>;
}

export function parseSqaaRequestBody(body: string | undefined): ParsedSqaaRequestBody {
  return JSON.parse(body ?? '{}') as ParsedSqaaRequestBody;
}

/** Path of the first entry in `files[]`. */
export function sqaaRequestFirstFilePath(body: string | undefined): string | undefined {
  return parseSqaaRequestBody(body).files?.[0]?.path;
}

/** Number of files in a SQAA request body. */
export function sqaaRequestFileCount(body: string | undefined): number {
  return parseSqaaRequestBody(body).files?.length ?? 0;
}

/** Sum of `files.length` across all recorded SQAA POST bodies. */
export function totalSqaaFilesSent(calls: RecordedRequest[]): number {
  return calls.reduce((sum, call) => sum + sqaaRequestFileCount(call.body), 0);
}

/** True when every change-set SQAA call uses `analysisDepth: DEEP`. */
export function allSqaaRequestsUseDeep(calls: RecordedRequest[]): boolean {
  return calls.every((call) => parseSqaaRequestBody(call.body).analysisDepth === 'DEEP');
}
