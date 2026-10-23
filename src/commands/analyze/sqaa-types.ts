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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import type { Console } from '@/core/ui/console.ts';

import type { SqaaTelemetryCallerCommand } from './sqaa-analysis-telemetry.ts';
import type { IgnoredFile } from './sqaa-changeset.ts';
import type { SqaaDeepWireDepth } from './sqaa-depth.ts';
import type { SqaaPath } from './sqaa-paths.ts';
import type { SqaaAnalysisDepth } from './sqaa-wire-types.ts';

export const VALID_FORMATS = ['text', 'json'] as const;
export type OutputFormat = (typeof VALID_FORMATS)[number];

export interface AnalyzeSqaaRunOptions {
  requireProject?: boolean;
  /** A missing project or organization skips without a console warning, for unattended hooks that run in every repository. */
  silentSkip?: boolean;
  telemetryCallerCommand?: SqaaTelemetryCallerCommand;
  /** Overrides computed CLI exit for telemetry only (e.g. non-blocking hooks always exit 0). */
  telemetryProcessExitCode?: number | null;
  /** Invocation context used to record telemetry facts. */
  telemetryCtx?: CommandInvocationContext;
  /** Auth the analysis ran against; identity is resolved from it at drain time. */
  auth?: ResolvedAuth;
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

/** The files of one run that belong to one SonarQube project. */
export interface SqaaProjectGroup {
  projectKey: string;
  /** Base for the paths sent to SQAA, which matches them against the project's analysis root. */
  projectRoot: string;
  /** Absolute paths. */
  files: string[];
}

/** A project's files with every path a run needs for each (see `SqaaPath`). */
export interface SqaaProjectFiles {
  projectKey: string;
  files: SqaaPath[];
}

/** One run's files, resolved once; the display views are derived from `projects`, never built by callers. */
export interface SqaaRunFiles {
  projects: SqaaProjectFiles[];
  displayProjects: SqaaDisplayProject[];
  /** Every display path of the run, in project order. */
  displayPaths: string[];
}

/** One project's files as the report shows them, so the display layer can group findings by project. */
export interface SqaaDisplayProject {
  projectKey: string;
  /** Display paths, in the order they are reported. */
  paths: string[];
}

export interface SqaaResolvedRun {
  connection: SonarConnection;
  groups: SqaaProjectGroup[];
  /** Files no project of the active connection owns, each with why (`outside-project` or `other-connection`). */
  ignored: IgnoredFile[];
  /** Every root the files were matched against, so an error about `outside-project` files can name them. */
  projectRoots: string[];
}

export interface SqaaBatchRunOptions {
  resolved: SqaaResolvedRun;
  console: Console;
  branch?: string;
  format?: OutputFormat;
  wireDepth?: SqaaDeepWireDepth;
  displayDepth?: SqaaAnalysisDepth;
  telemetryCallerCommand?: SqaaTelemetryCallerCommand;
  telemetryCtx?: CommandInvocationContext;
}

export interface SingleFileRunOptions {
  connection: SonarConnection;
  console: Console;
  branch?: string;
  explicitProject?: string;
  format?: OutputFormat;
  requireProject?: boolean;
  wireDepth?: SqaaDeepWireDepth;
  displayDepth?: SqaaAnalysisDepth;
  telemetryCallerCommand?: SqaaTelemetryCallerCommand;
  telemetryCtx?: CommandInvocationContext;
}
