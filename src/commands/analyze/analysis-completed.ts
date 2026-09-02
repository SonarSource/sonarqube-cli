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

/** Short telemetry event name for one analyzer run. */
export const CLI_ANALYSIS_COMPLETED = 'CliAnalysisCompleted';

export type AnalysisTelemetryAnalyzer = 'sonar-secrets' | 'sqaa' | 'sca-scanner-cli';

/** Domain payload for CliAnalysisCompleted (identity is filled at drain time). */
export type AnalysisCompletedPayload = {
  caller_command: string;
  analyzer: AnalysisTelemetryAnalyzer;
  analysis_id: string;
  findings_count: number;
  exit_code: number | null;
  errors_count: number;
  failures_count: number;
  scan_duration_ms: number;
  details: string;
};
