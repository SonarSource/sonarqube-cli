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

// Three-way pass/fail/not-computed verdict and its exit code

export const EXIT_CODE_QUALITY_GATE_FAILED = 51;

export type QualityGateVerdict = 'OK' | 'ERROR' | 'NOT_COMPUTED';

/**
 * `WARN` is a legacy status; it and `ERROR` both bucket to "failed" since the CLI only
 * surfaces the three-way pass/fail/not-computed verdict at this stage.
 */
export function toVerdict(
  status: 'OK' | 'WARN' | 'ERROR' | 'NONE' | undefined,
): QualityGateVerdict {
  if (!status || status === 'NONE') {
    return 'NOT_COMPUTED';
  }
  return status === 'OK' ? 'OK' : 'ERROR';
}

export function exitCodeFor(verdict: QualityGateVerdict): number {
  switch (verdict) {
    case 'OK':
      return 0;
    case 'ERROR':
      return EXIT_CODE_QUALITY_GATE_FAILED;
    case 'NOT_COMPUTED':
      return 1;
  }
}
