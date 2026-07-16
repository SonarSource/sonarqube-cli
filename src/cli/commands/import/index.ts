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

import type { ResolvedAuth } from '../../../lib/auth-resolver';
import { runWithConcurrencyLimit } from '../../../lib/concurrency-pool';
import { SonarQubeClient } from '../../../sonarqube/client';
import { info, intro, outro } from '../../../ui';
import { ImportProgress } from '../../../ui/components/import-progress.js';
import { CommandFailedError } from '../_common/error';
import {
  BACK,
  type OnlyPrivateProjects,
  type ResolvedRepo,
  type ResolvedRepos,
  resolveOrg,
  resolveRepos,
} from './_common/resolve-options';
import type { ImportOptions } from './_common/types';

export { type ImportOptions } from './_common/types';

/** Max number of `provision_projects` calls run concurrently. */
const IMPORT_PROVISION_CONCURRENCY_LIMIT = 10;

/**
 * Resolves org + repos together so choosing "← Back" from the repo-onboarding-mode prompt can
 * loop back to organization selection — re-deriving `almKey`/`onlyPrivateProjects` for whichever
 * org ends up chosen, since those are org-specific.
 */
async function resolveOrgAndRepos(
  client: SonarQubeClient,
  options: ImportOptions,
): Promise<{ orgKey: string } & ResolvedRepos> {
  for (;;) {
    const {
      key: orgKey,
      almKey: resolvedAlmKey,
      onlyPrivateProjectsEnabled,
    } = await resolveOrg(client, options);

    info(`Organization: ${orgKey}`);

    const [almKey, privateProjectsAvailable] = await Promise.all([
      resolvedAlmKey ?? client.getOrganizationAlmKey(orgKey),
      client.hasPrivateProjectsEntitlement(orgKey),
    ]);
    const onlyPrivateProjects: OnlyPrivateProjects = {
      enabled: onlyPrivateProjectsEnabled ?? false,
      available: privateProjectsAvailable,
    };

    const outcome = await resolveRepos(client, orgKey, almKey, onlyPrivateProjects, options);
    if (outcome === BACK) {
      continue;
    }

    return { orgKey, ...outcome };
  }
}

export async function importHandler(options: ImportOptions, auth: ResolvedAuth): Promise<void> {
  const client = new SonarQubeClient(auth.serverUrl, auth.token);

  intro('Import repositories', 'SonarQube');

  const { orgKey, repos, skipped } = await resolveOrgAndRepos(client, options);

  info(`Repositories to import: ${repos.length}`);
  if (skipped.length > 0) {
    info(`Repositories skipped: ${skipped.length}`);
    const countsByReason = new Map<string, number>();
    for (const s of skipped) {
      countsByReason.set(s.reason, (countsByReason.get(s.reason) ?? 0) + 1);
    }
    for (const [reason, count] of countsByReason) {
      info(`  - ${reason}: ${count}`);
    }
  }

  const progress = new ImportProgress({
    repos: repos.map((repo) => repo.slug),
    maxVisible: IMPORT_PROVISION_CONCURRENCY_LIMIT,
  });
  progress.start();

  await runWithConcurrencyLimit(
    repos,
    IMPORT_PROVISION_CONCURRENCY_LIMIT,
    async (repo: ResolvedRepo) => {
      progress.update(repo.slug, 'running');
      try {
        const result = await client.provisionProject(orgKey, repo.installationKey);
        if (result.projects.length === 0) {
          throw new Error(
            'provision_projects returned no project — the repository may already be bound, or ' +
              'the installation key was rejected by the server.',
          );
        }
        const project = result.projects[0];
        progress.update(repo.slug, 'done', 'Project created', project.projectKey);
        return project;
      } catch (err) {
        progress.update(repo.slug, 'failed', err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
  );

  const { succeeded, failed } = progress.finish();
  const skippedSuffix = skipped.length > 0 ? ` (${skipped.length} skipped)` : '';

  if (failed > 0) {
    const failedNoun = failed === 1 ? 'repository' : 'repositories';
    const message =
      succeeded === 0
        ? `Failed to import ${failed} ${failedNoun}.`
        : `Imported ${succeeded} of ${repos.length} repositories (${failed} failed)${skippedSuffix}.`;
    throw new CommandFailedError(message, {
      remediationHint: 'See the per-repository errors above for details.',
    });
  }

  const succeededNoun = succeeded === 1 ? 'repository' : 'repositories';
  outro(`Imported ${succeeded} ${succeededNoun}${skippedSuffix}`, 'success');
}
