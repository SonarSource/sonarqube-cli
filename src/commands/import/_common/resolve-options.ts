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

import { CommandFailedError, InvalidOptionError } from '@/core/command-error.ts';
import { type DopRepository, type SonarQubeClient } from '@/core/server/client.ts';
import { type MultiSelectOption } from '@/core/ui';
import type { Console } from '@/core/ui/console.ts';

import {
  type FetchPage,
  isAlreadyImported,
  iterateRepoPages,
  type OnlyPrivateProjects,
  RepositoryCollection,
  type SkippedRepo,
} from './repository-collection';

const GITHUB_ALM_KEY = 'github';
/** Azure DevOps as `Organization.alm.key` spells it. */
const AZURE_DEVOPS_ALM_KEY = 'microsoft';
/** Azure DevOps elsewhere, where the key carries a suffix (e.g. `azure_devops`). */
const AZURE_DEVOPS_ALM_KEY_PREFIX = 'azure';

export interface ResolvedOrg {
  key: string;
  /** Undefined if the org has no DevOps platform connected. */
  almKey?: string;
  /**
   * `Organization.onlyPrivateProjects.enabled`. Undefined only when the org itself has it
   * unset — a network/API failure or a missing/non-admin org is NOT folded into this, it
   * throws instead (see `resolveOrgByKey`), so callers can safely default this to `false` (no
   * restriction) without silently disabling visibility enforcement on a transient error. The
   * `available` half of `OnlyPrivateProjects` comes from a separate billing entitlement
   * check, not from here.
   */
  onlyPrivateProjectsEnabled?: boolean;
}

export interface ResolvedRepo {
  slug: string;
  /** ALM-specific identifier expected by `provision_projects`' `installationKeys` param. */
  installationKey: string;
}

/**
 * Outcome of resolving which repositories to import:
 * - `streaming` — `--all`/"Recommended" and `--regex`/"By pattern" both hand back the live
 *   `RepositoryCollection` itself so the caller can run the fetch-a-page/import-a-page job (see
 *   `runBulkImportJob` in `index.ts`) instead of a fully materialized list. `regex` is `undefined`
 *   for `--all`/"Recommended" (import every eligible repo) or a compiled pattern for
 *   `--regex`/"By pattern" (import only eligible repos whose name matches); either way it's
 *   applied by that job as a live per-page filter, not baked into the collection itself.
 * - `batch` — manual selection and `--repo` already know their (small, explicit) final list, so
 *   they resolve to it directly and the caller runs one single-batch import.
 */
export type RepoResolution =
  | { kind: 'streaming'; collection: RepositoryCollection; regex: RegExp | undefined }
  | { kind: 'batch'; repos: ResolvedRepo[]; skipped: SkippedRepo[] };

/**
 * Format a DOP repository's unique identifier the way `provision_projects` expects it:
 * `<slug>|<id>` for GitHub, plain `id` for every other DevOps platform.
 */
export function computeInstallationKey(
  repo: { id: string; slug: string },
  almKey: string | undefined,
): string {
  return almKey === GITHUB_ALM_KEY ? `${repo.slug}|${repo.id}` : repo.id;
}

/** e.g. `my-org/repo - private`, or `my-org/repo - private (already imported)`. */
function formatRepoLabel(
  repo: { slug: string; private: boolean },
  alreadyImported = false,
): string {
  const visibility = repo.private ? 'private' : 'public';
  const suffix = alreadyImported ? ' (already imported)' : '';
  return `${repo.slug} - ${visibility}${suffix}`;
}

/**
 * Resolve the organization to import into: always the one already tied to the active
 * connection (`auth.orgKey`), never chosen interactively. Still verifies the org exists and
 * that the caller is an admin of it before proceeding.
 */
export async function resolveOrg(
  client: SonarQubeClient,
  orgKey: string | undefined,
): Promise<ResolvedOrg> {
  if (!client.isCloud) {
    throw new CommandFailedError('sonar import is only supported on SonarQube Cloud.', {
      remediationHint: "Run 'sonar auth login' and connect to SonarQube Cloud, then retry.",
    });
  }

  if (!orgKey) {
    throw new CommandFailedError('No SonarQube Cloud organization is configured.', {
      remediationHint: "Run 'sonar auth login' and connect to an organization, then retry.",
    });
  }

  return resolveOrgByKey(client, orgKey);
}

async function resolveOrgByKey(client: SonarQubeClient, orgKey: string): Promise<ResolvedOrg> {
  let org;
  try {
    org = await client.fetchOrganizationByKey(orgKey);
  } catch (err) {
    throw new CommandFailedError(
      `Failed to look up organization '${orgKey}': ${err instanceof Error ? err.message : String(err)}`,
      { remediationHint: 'Check your network connection and authentication, then retry.' },
    );
  }

  if (!org) {
    throw new CommandFailedError(`Organization '${orgKey}' not found.`, {
      remediationHint: 'Check that the organization key is correct and that you have access to it.',
    });
  }

  if (org.actions?.admin !== true) {
    throw new CommandFailedError(
      `You must be an administrator of organization '${orgKey}' to import repositories.`,
      { remediationHint: 'Ask an administrator of this organization to run the import instead.' },
    );
  }

  return {
    key: orgKey,
    almKey: org.alm?.key,
    onlyPrivateProjectsEnabled: org.onlyPrivateProjects?.enabled,
  };
}

/** The API doesn't guarantee the casing it reports; a blank key means no platform. */
export function normalizeAlmKey(almKey: string | undefined): string | undefined {
  return almKey?.trim().toLowerCase() || undefined;
}

/**
 * Rejects any organization not bound to GitHub or Azure DevOps, an unresolved platform included:
 * unknown is not a licence to import, since `dop-repositories` is keyed on the organization alone
 * and returns its repositories whatever the platform turns out to be.
 */
export function assertSupportedAlm(orgKey: string, almKey: string | undefined): void {
  if (
    almKey === GITHUB_ALM_KEY ||
    almKey === AZURE_DEVOPS_ALM_KEY ||
    almKey?.startsWith(AZURE_DEVOPS_ALM_KEY_PREFIX)
  ) {
    return;
  }

  const platform = almKey ? `'${almKey}'` : 'no DevOps platform';
  throw new CommandFailedError(
    `sonar import supports GitHub and Azure DevOps organizations only, but '${orgKey}' is bound ` +
      `to ${platform}.`,
    { remediationHint: 'Import these repositories from SonarQube Cloud in your browser instead.' },
  );
}

/** The key from the org record when it carries one, otherwise the organization-bindings lookup. */
export async function resolveAlmKey(
  client: SonarQubeClient,
  orgKey: string,
  orgRecordAlmKey: string | undefined,
): Promise<string | undefined> {
  if (orgRecordAlmKey !== undefined) {
    return normalizeAlmKey(orgRecordAlmKey);
  }

  try {
    return normalizeAlmKey(await client.getOrganizationAlmKey(orgKey));
  } catch (err) {
    throw new CommandFailedError(
      `Failed to look up the DevOps platform for organization '${orgKey}': ${err instanceof Error ? err.message : String(err)}`,
      { remediationHint: 'Check your network connection and authentication, then retry.' },
    );
  }
}

/**
 * Compiles `input` as a `RegExp`. Supports the `/pattern/flags` literal syntax (e.g.
 * `/^archived-/i`) so flags — most usefully `i` for case-insensitive matching — are expressible:
 * JS has no inline `(?i)` modifier the way PCRE/Python do, so a bare pattern string can't
 * otherwise carry one. Anything else is treated as a plain pattern with no flags, as before.
 *
 * The literal syntax is only recognized when there's a non-empty pattern between the slashes and
 * the trailing segment consists solely of valid RegExp flag characters — both requirements are
 * enforced by the detection regex itself via backtracking, needing no separate validation step.
 * This avoids two ambiguities a looser match (any trailing lowercase letters, empty pattern
 * allowed) would create: a plain pattern that merely looks like `/pattern/flags` — e.g.
 * `/etc/passwd`, whose trailing segment "passwd" isn't a valid flag string — being rejected as
 * an invalid regex instead of compiled as the literal pattern the user meant; and a value like
 * `//` being read as an empty pattern, which matches (and would silently exclude) every
 * repository name.
 *
 * `g`/`y` are silently dropped even when given: this regex is reused via `.test()` against a
 * sequence of independent repository names, not repeated calls against the same string, so
 * `lastIndex` statefulness would only produce alternating false negatives — never a meaningful
 * "global" match — while every other flag (and the match result itself) behaves identically
 * with or without them.
 */
function compileRegexInput(input: string): RegExp {
  const literal = /^\/(.+)\/([dgimsuvy]*)$/.exec(input);
  if (!literal) {
    return new RegExp(input);
  }
  const [, pattern, flags] = literal;
  return new RegExp(pattern, flags.replace(/[gy]/g, ''));
}

/** Like `compileRegexInput`, but returns `undefined` instead of throwing on invalid syntax. */
function tryCompileRegex(input: string): RegExp | undefined {
  try {
    return compileRegexInput(input);
  } catch {
    return undefined;
  }
}

/**
 * Validates that at most one of `--all`/`--repo`/`--regex` is given, and `--regex`'s syntax when
 * present, eagerly regardless of interactivity — so an invalid combination or pattern fails
 * immediately rather than only once the org is resolved. Returns the compiled `--regex` value
 * (or `undefined` if omitted); callers use it directly for the standalone `--regex` mode, or
 * ignore it for `--all`/`--repo`/interactive resolution.
 */
function validateSelectionFlags(opts: {
  repo?: string[];
  all?: boolean;
  regex?: string;
}): RegExp | undefined {
  const given = [
    opts.all ? '--all' : null,
    opts.repo?.length ? '--repo' : null,
    opts.regex ? '--regex' : null,
  ].filter((flag): flag is string => flag !== null);

  if (given.length > 1) {
    throw new InvalidOptionError(
      `${given.join(', ')} cannot be combined`,
      'Pass exactly one of --all, --repo, or --regex to choose how to select repositories.',
    );
  }

  if (!opts.regex) {
    return undefined;
  }
  try {
    return compileRegexInput(opts.regex);
  } catch (err) {
    throw new InvalidOptionError(
      `--regex is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
      'Pass a regular expression pattern, e.g. --regex "^archived-", or wrap it as /pattern/flags to add flags, e.g. --regex "/^archived-/i" for case-insensitive matching.',
    );
  }
}

/**
 * Internal-only signal: returned by `promptForReposFromCollection` and `promptForRegex` when
 * cancelled, so `resolveOnboardingMode`'s loop can redisplay the mode menu. Never escapes
 * `resolveOnboardingMode`.
 */
const BACK = Symbol('back');

/**
 * Prompts for a mandatory regex when the user has chosen "By pattern" from the onboarding-mode
 * menu — unlike an optional filter, there's no "skip" here: choosing this mode means the user
 * wants one, so blank or invalid input just re-prompts. Cancelling (Ctrl+C) returns `BACK` to the
 * mode-select menu, consistent with cancelling the Manual picker.
 */
async function promptForRegex(console: Console): Promise<RegExp | typeof BACK> {
  for (;;) {
    const input = await console.textPrompt(
      'Import repositories whose name matches (regex, e.g. /^archived-/i)',
    );
    if (input === null) {
      return BACK;
    }
    const compiled = input.trim() === '' ? undefined : tryCompileRegex(input.trim());
    if (compiled) {
      return compiled;
    }
    console.print(
      'Please enter a valid, non-empty regular expression (e.g. /pattern/i for case-insensitive).',
    );
  }
}

export async function resolveRepos(
  client: SonarQubeClient,
  orgKey: string,
  almKey: string | undefined,
  onlyPrivateProjects: OnlyPrivateProjects,
  opts: {
    repo?: string[];
    all?: boolean;
    regex?: string;
    nonInteractive?: boolean;
    console: Console;
  },
): Promise<RepoResolution> {
  const console = opts.console;
  const regexFromFlag = validateSelectionFlags(opts);

  if (opts.nonInteractive && !opts.repo?.length && !opts.all && !opts.regex) {
    throw new InvalidOptionError(
      '--repo, --all, or --regex is required in non-interactive mode',
      'Pass --repo <slug> to specify one or more repositories directly, --all to import every eligible one, or --regex <pattern> to import only eligible repositories matching a pattern.',
    );
  }

  const organizationId = await client.getOrganizationLegacyId(orgKey);
  if (!organizationId) {
    throw new CommandFailedError(`Organization '${orgKey}' not found.`, {
      remediationHint: 'Check that the organization key is correct and that you have access to it.',
    });
  }

  if (opts.all) {
    return resolveStreamingImport(client, organizationId, onlyPrivateProjects, undefined, console);
  }

  if (opts.regex) {
    return resolveStreamingImport(
      client,
      organizationId,
      onlyPrivateProjects,
      regexFromFlag,
      console,
    );
  }

  if (opts.repo?.length) {
    const repos = await resolveReposBySlug(
      client,
      organizationId,
      almKey,
      onlyPrivateProjects,
      opts.repo,
    );
    return { kind: 'batch', repos, skipped: [] };
  }

  return resolveOnboardingMode(client, organizationId, almKey, onlyPrivateProjects, console);
}

/**
 * Load pages of an org's repositories (via `RepositoryCollection.create`, which stops once it
 * finds at least one eligible repo or the org is exhausted) and throw a `CommandFailedError` on
 * a fetch failure or an org with no repositories at all.
 */
async function createRepositoryCollectionOrThrow(
  client: SonarQubeClient,
  organizationId: string,
  onlyPrivateProjects: OnlyPrivateProjects,
  console: Console,
): Promise<RepositoryCollection> {
  let collection: RepositoryCollection;
  try {
    collection = await console.withSpinner('Loading repositories...', () =>
      RepositoryCollection.create(
        (pageIndex, pageSize) =>
          client.fetchDopRepositoriesPage(organizationId, pageIndex, pageSize),
        onlyPrivateProjects,
      ),
    );
  } catch (err) {
    throw new CommandFailedError(
      `Failed to load repositories: ${err instanceof Error ? err.message : String(err)}`,
      { remediationHint: 'Check your network connection and authentication, then retry.' },
    );
  }

  if (collection.total === 0) {
    throw new CommandFailedError('No repositories found for the selected organization.', {
      remediationHint:
        'The organization may have no repositories visible to its connected DevOps platform, or the platform connection may need to be reconfigured.',
    });
  }

  return collection;
}

/**
 * Throws with a specific reason when an org has nothing importable. `RepositoryCollection.create`
 * only stops early once it finds an eligible repo, so this is only called once every fetched page
 * has been fully scanned.
 */
function handleNoEligibleRepos(collection: RepositoryCollection): never {
  const reason = collection.skippedRepos.every((repo) => repo.reason === 'already imported')
    ? 'All repositories for the selected organization have already been imported into SonarQube.'
    : "No repositories match this organization's project visibility settings.";
  throw new CommandFailedError(reason);
}

/**
 * Ask how the user wants to pick repositories to import: bulk-import everything eligible
 * (mirrors `--all`), choose specific ones interactively, or import only those matching a pattern
 * (mirrors `--regex`).
 *
 * The collection is loaded just far enough to know whether anything is eligible before the
 * prompt is even shown, so an org with nothing importable fails immediately with a specific
 * reason — asking which mode to use would be pointless (every branch would hit the same dead
 * end) when there's nothing to import either way. Whichever mode is chosen continues fetching
 * from this same collection rather than starting over from page one.
 */
async function resolveOnboardingMode(
  client: SonarQubeClient,
  organizationId: string,
  almKey: string | undefined,
  onlyPrivateProjects: OnlyPrivateProjects,
  console: Console,
): Promise<RepoResolution> {
  const collection = await createRepositoryCollectionOrThrow(
    client,
    organizationId,
    onlyPrivateProjects,
    console,
  );

  if (collection.eligibleRepos.length === 0) {
    handleNoEligibleRepos(collection);
  }

  const RECOMMENDED = Symbol('recommended');
  const MANUAL = Symbol('manual');
  const BY_PATTERN = Symbol('by-pattern');

  const options: Array<{
    value: typeof RECOMMENDED | typeof MANUAL | typeof BY_PATTERN;
    label: string;
  }> = [
    { value: RECOMMENDED, label: 'Recommended — import all eligible repositories automatically' },
    { value: MANUAL, label: 'Manual — choose repositories yourself' },
    { value: BY_PATTERN, label: 'By pattern — import repositories whose name matches a regex' },
  ];

  // Cancelling the "Manual" picker or the "By pattern" prompt (below) re-shows this same menu
  // instead of ending the command, so the user can pick a different mode rather than starting
  // `sonar import` over from scratch.
  for (;;) {
    const choice = await console.selectPrompt('How do you want to import repositories?', options);

    if (choice === null) {
      throw new CommandFailedError('Repository selection cancelled');
    }
    if (choice === RECOMMENDED) {
      return { kind: 'streaming', collection, regex: undefined };
    }
    if (choice === BY_PATTERN) {
      const regex = await promptForRegex(console);
      if (regex === BACK) {
        continue;
      }
      return { kind: 'streaming', collection, regex };
    }

    const repos = await promptForReposFromCollection(collection, almKey, console);
    if (repos === BACK) {
      continue;
    }
    return { kind: 'batch', repos, skipped: [] };
  }
}

async function resolveReposBySlug(
  client: SonarQubeClient,
  organizationId: string,
  almKey: string | undefined,
  onlyPrivateProjects: OnlyPrivateProjects,
  slugs: string[],
): Promise<ResolvedRepo[]> {
  const matches = await findReposBySlugs(
    (pageIndex, pageSize) => client.fetchDopRepositoriesPage(organizationId, pageIndex, pageSize),
    slugs,
  );

  const notFound = slugs.filter((slug) => !matches.has(slug));
  if (notFound.length > 0) {
    throw new CommandFailedError(
      `Repositor${notFound.length === 1 ? 'y' : 'ies'} not found in the selected organization's DevOps platform: ${notFound.join(', ')}`,
      { remediationHint: 'Check that the repository slug(s) are correct and visible to the org.' },
    );
  }

  const alreadyImported = slugs
    .map((slug) => matches.get(slug))
    .filter((repo): repo is DopRepository => repo !== undefined && isAlreadyImported(repo));
  if (alreadyImported.length === 1) {
    throw new CommandFailedError(
      `Repository '${alreadyImported[0].slug}' has already been imported into SonarQube.`,
    );
  }
  if (alreadyImported.length > 1) {
    throw new CommandFailedError(
      `Repositories have already been imported into SonarQube: ${alreadyImported
        .map((repo) => repo.slug)
        .join(', ')}`,
    );
  }

  const notSelectable = slugs
    .map((slug) => matches.get(slug))
    .filter(
      (repo): repo is DopRepository =>
        repo !== undefined && !isRepoSelectable(repo, onlyPrivateProjects),
    );
  if (notSelectable.length === 1) {
    const repo = notSelectable[0];
    throw new CommandFailedError(
      `Repository '${repo.slug}' is ${repo.private ? 'private' : 'public'}, which isn't allowed by this organization's project visibility settings.`,
    );
  }
  if (notSelectable.length > 1) {
    throw new CommandFailedError(
      `Repositories are not allowed by this organization's project visibility settings: ${notSelectable
        .map((repo) => `${repo.slug} (${repo.private ? 'private' : 'public'})`)
        .join(', ')}`,
    );
  }

  return slugs.map((slug) => {
    const repo = matches.get(slug);
    if (!repo) {
      throw new CommandFailedError(`Repository '${slug}' not found.`);
    }
    return { slug: repo.slug, installationKey: computeInstallationKey(repo, almKey) };
  });
}

/**
 * Whether a repo's visibility is selectable under the org's `onlyPrivateProjects` setting.
 * Unavailable means public-only, available+enabled means private-only, available+disabled
 * allows both. Duplicated in spirit from `RepositoryCollection`'s internal categorization —
 * `--repo` resolution needs this on a handful of explicitly-named repos, not on every page.
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
 * Resolve a live streaming job for `--all` (`regex` undefined, import every eligible repo) or
 * `--regex` (`regex` set, import only eligible repos whose name matches): the caller
 * (`runBulkImportJob`) imports each page's eligible-and-matching repos as soon as it's fetched
 * instead of waiting for the whole org to be scanned first.
 */
async function resolveStreamingImport(
  client: SonarQubeClient,
  organizationId: string,
  onlyPrivateProjects: OnlyPrivateProjects,
  regex: RegExp | undefined,
  console: Console,
): Promise<RepoResolution> {
  const collection = await createRepositoryCollectionOrThrow(
    client,
    organizationId,
    onlyPrivateProjects,
    console,
  );

  if (collection.eligibleRepos.length === 0) {
    throw new CommandFailedError(
      `No repositories are eligible for import (${collection.skippedRepos.length} skipped: already imported, or excluded by project visibility settings).`,
    );
  }

  return { kind: 'streaming', collection, regex };
}

/**
 * Fetch an org's repositories page by page, stopping as soon as every requested slug has been
 * matched instead of always scanning the whole org.
 */
async function findReposBySlugs(
  fetchPage: FetchPage,
  slugs: string[],
): Promise<Map<string, DopRepository>> {
  const remaining = new Set(slugs);
  const found = new Map<string, DopRepository>();

  for await (const { repositories } of iterateRepoPages(fetchPage)) {
    for (const repo of repositories) {
      if (remaining.has(repo.slug)) {
        found.set(repo.slug, repo);
        remaining.delete(repo.slug);
      }
    }
    if (remaining.size === 0) break;
  }

  return found;
}

/**
 * Interactive multi-select over a live, lazily-paginated `RepositoryCollection`: "Load more"
 * fetches and categorizes the next server page on demand. There's no "select all" here — the
 * full set is never known up front, so there is nothing safe to bulk-select.
 */
async function promptForReposFromCollection(
  collection: RepositoryCollection,
  almKey: string | undefined,
  console: Console,
): Promise<ResolvedRepo[] | typeof BACK> {
  // `multiSelectPrompt` tracks selections by `===` identity, so the same `DopRepository`
  // must always map to the same `ResolvedRepo` object across a "Load more" reload, or
  // previously toggled selections would be silently dropped.
  const resolvedByRepo = new WeakMap<DopRepository, ResolvedRepo>();
  const toOption = (
    repo: DopRepository,
    alreadyImported = false,
  ): MultiSelectOption<ResolvedRepo> => {
    let resolved = resolvedByRepo.get(repo);
    if (!resolved) {
      resolved = { slug: repo.slug, installationKey: computeInstallationKey(repo, almKey) };
      resolvedByRepo.set(repo, resolved);
    }
    return {
      value: resolved,
      label: formatRepoLabel(repo, alreadyImported),
      disabled: alreadyImported,
    };
  };
  // Already-imported repos are listed too (dimmed, non-toggleable) so the picker shows every
  // repo the org has, not just the ones still importable.
  const buildOptions = (): MultiSelectOption<ResolvedRepo>[] => [
    ...collection.eligibleRepos.map((repo) => toOption(repo)),
    ...collection.alreadyImportedRepos.map((repo) => toOption(repo, true)),
  ];

  const result = await console.multiSelectPrompt('Select repositories to import', buildOptions(), {
    hasMore: () => collection.hasMore,
    onLoadMore: async () => {
      await collection.loadMore();
      return buildOptions();
    },
    // No cap on Manual selection — every eligible repo paginated into view can be selected.
    maxSelected: Infinity,
    // Only what's been paginated into view so far — the true total isn't known until every
    // page has been fetched, which is exactly why there's no "select all" for this picker.
    total: () => collection.eligibleRepos.length,
  });

  // Cancelling (q / Ctrl+C) goes back to the Recommended/Manual/By pattern menu that led here,
  // rather than ending the whole command — the caller (`resolveOnboardingMode`) re-shows it.
  if (result === null) {
    return BACK;
  }
  if (result.length === 0) {
    throw new CommandFailedError('No repositories selected.');
  }

  return result;
}
