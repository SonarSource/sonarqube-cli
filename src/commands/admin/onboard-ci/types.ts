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

export interface OnboardCiOptions {
  bindingName?: string;
  reposFile?: string;
  dryRun?: boolean;
}

export interface RepoProject {
  repo: string;
  projectKey: string;
}

export interface OpenedResult extends RepoProject {
  prUrl: string;
}

export interface SkippedResult {
  repo: string;
  reason: string;
  prUrl?: string;
}

export interface FailedResult {
  repo: string;
  error: string;
}

export type RepoOutcome =
  | { outcome: 'proceed'; projectKey: string }
  | { outcome: 'opened'; projectKey: string; prUrl: string }
  | { outcome: 'skip'; reason: string; prUrl?: string; message?: string };

export interface RepoRunResults {
  opened: OpenedResult[];
  wouldOpen: RepoProject[];
  skipped: SkippedResult[];
  failed: FailedResult[];
}
