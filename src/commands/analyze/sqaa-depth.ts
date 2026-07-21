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

import type { SqaaAnalysisDepth } from '../../sonarqube/client.ts';
import { InvalidOptionError } from '../_common/error.ts';

export const SQAA_DEPTH_CHOICES = ['STANDARD', 'DEEP'] as const;

export type SqaaInvocationMode = 'single-file' | 'multi-file' | 'change-set';

/** Wire value sent to SQAA when DEEP analysis is requested (STANDARD omits the field). */
export type SqaaDeepWireDepth = 'DEEP';

/**
 * Resolve analysis depth for SQAA API calls.
 * `forcedDepth` is for hook callers only — STANDARD omits `analysisDepth` on the wire.
 */
export function resolveAnalysisDepth(
  explicitDepth: SqaaAnalysisDepth | undefined,
  mode: SqaaInvocationMode,
  forcedDepth?: SqaaAnalysisDepth,
): SqaaDeepWireDepth | undefined {
  if (forcedDepth !== undefined) {
    return forcedDepth === 'DEEP' ? 'DEEP' : undefined;
  }
  if (explicitDepth === 'DEEP') {
    return 'DEEP';
  }
  if (explicitDepth === 'STANDARD') {
    return undefined;
  }
  return mode === 'single-file' ? undefined : 'DEEP';
}

/** Label for CLI output and JSON reports (always STANDARD or DEEP). */
export function labelAnalysisDepth(wireDepth: SqaaDeepWireDepth | undefined): SqaaAnalysisDepth {
  return wireDepth === 'DEEP' ? 'DEEP' : 'STANDARD';
}

export function parseSqaaDepthOption(value: string): SqaaAnalysisDepth {
  if (value === 'STANDARD' || value === 'DEEP') {
    return value;
  }
  throw new InvalidOptionError(
    `Invalid --depth '${value}'.`,
    'Use --depth STANDARD or --depth DEEP.',
  );
}
