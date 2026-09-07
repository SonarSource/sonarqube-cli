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

import { type DopRepository, ImportApiClient } from './import-api.ts';

export type FetchPage = (
  pageIndex: number,
  pageSize: number,
) => Promise<{ repositories: DopRepository[]; total: number }>;

export interface OnlyPrivateProjects {
  enabled: boolean;
  available: boolean;
}

export interface SkippedRepo {
  slug: string;
  reason: string;
}

/**
 * A repo is already imported if it's flagged for the current org, or already bound to a
 * project at all (e.g. imported into a different org) — either way it's not a fresh import.
 */
export function isAlreadyImported(repo: DopRepository): boolean {
  return repo.importedInCurrentOrg || repo.boundProjectIds.length > 0;
}

/**
 * Whether a repo's visibility is selectable under the org's `onlyPrivateProjects` setting.
 * Unavailable means public-only, available+enabled means private-only, available+disabled
 * allows both.
 */
function isRepoSelectable(
  repo: { private: boolean },
  onlyPrivateProjects: OnlyPrivateProjects,
): boolean {
  if (!onlyPrivateProjects.available) return !repo.private;
  if (onlyPrivateProjects.enabled) return repo.private;
  return true;
}

/**
 * Split repos into those eligible for import — not already imported (see `isAlreadyImported`)
 * and allowed by the org's project visibility settings — those already imported (kept as full
 * repos, not just a `SkippedRepo` reason, so the manual picker can list them), and those skipped
 * for visibility reasons.
 */
function categorizeRepos(
  repos: DopRepository[],
  onlyPrivateProjects: OnlyPrivateProjects,
): { eligible: DopRepository[]; alreadyImported: DopRepository[]; skipped: SkippedRepo[] } {
  const eligible: DopRepository[] = [];
  const alreadyImported: DopRepository[] = [];
  const skipped: SkippedRepo[] = [];

  for (const repo of repos) {
    if (isAlreadyImported(repo)) {
      alreadyImported.push(repo);
      skipped.push({ slug: repo.slug, reason: 'already imported' });
      continue;
    }
    if (!isRepoSelectable(repo, onlyPrivateProjects)) {
      skipped.push({
        slug: repo.slug,
        reason: `${repo.private ? 'private' : 'public'} repos aren't allowed by this organization's project visibility settings`,
      });
      continue;
    }
    eligible.push(repo);
  }

  return { eligible, alreadyImported, skipped };
}

/**
 * Yield one server page of repositories at a time, stopping as soon as a short page comes back
 * (rather than trusting the server-reported `total`, so a stale/inconsistent total can't cause
 * an infinite loop).
 */
export async function* iterateRepoPages(
  fetchPage: FetchPage,
): AsyncGenerator<{ repositories: DopRepository[]; total: number }, void> {
  let pageIndex = 1;
  for (;;) {
    const page = await fetchPage(pageIndex, ImportApiClient.DOP_REPOSITORIES_MAX_PAGE_SIZE);
    yield page;
    if (page.repositories.length < ImportApiClient.DOP_REPOSITORIES_MAX_PAGE_SIZE) {
      return;
    }
    pageIndex++;
  }
}

/**
 * A live, paginated, categorizing view over an org's repositories for the `sonar import` repo
 * prompt and bulk-import job: it fetches and categorizes one server page at a time instead of
 * eagerly loading the whole org up front, so `--all`/"Recommended" can start importing a page's
 * eligible repos while the next page is still unfetched, and the manual picker's "Load more"
 * triggers a genuine network request.
 */
export class RepositoryCollection {
  private readonly fetchPage: FetchPage;
  private readonly onlyPrivateProjects: OnlyPrivateProjects;
  private readonly eligible: DopRepository[] = [];
  private readonly alreadyImported: DopRepository[] = [];
  private readonly skipped: SkippedRepo[] = [];
  private exhausted = false;
  private serverTotal = 0;
  private nextPageIndex = 1;

  private constructor(fetchPage: FetchPage, onlyPrivateProjects: OnlyPrivateProjects) {
    this.fetchPage = fetchPage;
    this.onlyPrivateProjects = onlyPrivateProjects;
  }

  /**
   * Fetch pages until at least one eligible repo is found or the org is exhausted — avoids ever
   * showing a picker or starting a job with zero visible items when eligible repos exist a page
   * or two in.
   */
  static async create(
    fetchPage: FetchPage,
    onlyPrivateProjects: OnlyPrivateProjects,
  ): Promise<RepositoryCollection> {
    const collection = new RepositoryCollection(fetchPage, onlyPrivateProjects);
    while (collection.eligible.length === 0 && !collection.exhausted) {
      await collection.loadMore();
    }
    return collection;
  }

  /** Repos found eligible for import across every page fetched so far. */
  get eligibleRepos(): readonly DopRepository[] {
    return this.eligible;
  }

  /** Repos already imported (into this org or another) across every page fetched so far. */
  get alreadyImportedRepos(): readonly DopRepository[] {
    return this.alreadyImported;
  }

  /** Repos found ineligible (with a reason) across every page fetched so far. */
  get skippedRepos(): readonly SkippedRepo[] {
    return this.skipped;
  }

  /** True while more server pages remain unfetched. */
  get hasMore(): boolean {
    return !this.exhausted;
  }

  /** Server-reported total repo count for the org, known from the first page fetched. */
  get total(): number {
    return this.serverTotal;
  }

  /**
   * Fetch exactly one more server page, categorize it, append to the running totals, and return
   * just this page's delta (callers tracking the running totals themselves, like the manual
   * picker, can ignore the return value).
   *
   * Calls `fetchPage` directly (rather than driving a shared `AsyncGenerator`) so a failed fetch
   * can be retried: the page index is only advanced after a successful fetch, so a rejected call
   * leaves the collection pointed at the same page and `exhausted` unset, and the next `loadMore`
   * re-fetches it instead of silently behaving as if the org had no further pages (per-instance
   * generators become permanently done once they throw, which would break retry).
   */
  async loadMore(): Promise<{
    eligible: DopRepository[];
    alreadyImported: DopRepository[];
    skipped: SkippedRepo[];
  }> {
    if (this.exhausted) return { eligible: [], alreadyImported: [], skipped: [] };

    const page = await this.fetchPage(
      this.nextPageIndex,
      ImportApiClient.DOP_REPOSITORIES_MAX_PAGE_SIZE,
    );
    this.nextPageIndex++;

    this.serverTotal = page.total;
    if (page.repositories.length < ImportApiClient.DOP_REPOSITORIES_MAX_PAGE_SIZE) {
      this.exhausted = true;
    }

    const { eligible, alreadyImported, skipped } = categorizeRepos(
      page.repositories,
      this.onlyPrivateProjects,
    );
    this.eligible.push(...eligible);
    this.alreadyImported.push(...alreadyImported);
    this.skipped.push(...skipped);
    return { eligible, alreadyImported, skipped };
  }
}
