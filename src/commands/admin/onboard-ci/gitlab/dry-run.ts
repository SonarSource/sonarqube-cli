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

import type { RepoClassification, RepoWithBranch } from './processor.ts';
import type { DryRunResults } from './types.ts';

export interface ClassificationEntry {
  repo: RepoWithBranch;
  classification: RepoClassification | null;
}

export function computeDryRunResults(
  entries: ClassificationEntry[],
  failedRepos: { repo: string; error: string }[],
): DryRunResults {
  const wouldOpenMr: DryRunResults['wouldOpenMr'] = [];
  const wouldSkip: DryRunResults['wouldSkip'] = [];

  for (const { repo, classification } of entries) {
    if (!classification) continue;
    if (classification.outcome === 'skip') {
      wouldSkip.push({ repo: repo.path_with_namespace, reason: classification.reason });
    } else {
      wouldOpenMr.push({
        repo: repo.path_with_namespace,
        projectKey: classification.projectKey,
      });
    }
  }

  return { wouldOpenMr, wouldSkip, failed: failedRepos };
}
