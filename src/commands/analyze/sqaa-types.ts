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

import type { ResolvedAuth } from '../../lib/auth-resolver.ts';
import type { SqaaAnalysisDepth } from '../../sonarqube/client.ts';
import type { SqaaTelemetryCallerCommand } from '../../telemetry/sqaa-analysis-telemetry.ts';
import type { CloudAuth } from './sqaa-auth.ts';
import type { SqaaDeepWireDepth } from './sqaa-depth.ts';

export const VALID_FORMATS = ['text', 'json'] as const;
export type OutputFormat = (typeof VALID_FORMATS)[number];

export interface AnalyzeSqaaRunOptions {
  requireProject?: boolean;
  telemetryCallerCommand?: SqaaTelemetryCallerCommand;
  /** Overrides computed CLI exit for telemetry only (e.g. non-blocking hooks always exit 0). */
  telemetryProcessExitCode?: number | null;
  /**
   * When true, SqaaForbiddenError propagates out of the analysis instead of being
   * recorded as a chunk failure. Set by hook callers that want to show a nudge message.
   */
  propagateForbiddenError?: boolean;
}

export interface AnalyzeSqaaOptions {
  file?: string[];
  staged?: boolean;
  base?: string;
  branch?: string;
  project?: string;
  force?: boolean;
  format?: OutputFormat;
  depth?: string;
  /** Internal: hooks force STANDARD without exposing `--depth` on the CLI. */
  forcedDepth?: SqaaAnalysisDepth;
}

export interface SqaaResolvedContext {
  cloudAuth: CloudAuth;
  projectKey: string;
}

export interface SqaaBatchRunOptions {
  resolved: SqaaResolvedContext;
  auth: ResolvedAuth;
  branch?: string;
  format?: OutputFormat;
  wireDepth?: SqaaDeepWireDepth;
  displayDepth?: SqaaAnalysisDepth;
  telemetryCallerCommand?: SqaaTelemetryCallerCommand;
}

export interface SingleFileRunOptions {
  branch?: string;
  explicitProject?: string;
  format?: OutputFormat;
  requireProject?: boolean;
  wireDepth?: SqaaDeepWireDepth;
  displayDepth?: SqaaAnalysisDepth;
  telemetryCallerCommand?: SqaaTelemetryCallerCommand;
}
