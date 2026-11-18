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

import { findInstalledIntegrationIds } from '@/commands/integrate/_common/installed-integrations.ts';
import { FolderSelectionCancelledError } from '@/commands/link/choose-folder.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { relativeProjectPath } from '@/core/project-discovery/link-target.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import type { Console } from '@/core/ui/console.ts';

import { OnboardingCancelledError } from './answer.ts';
import type { InitOutcome, InitPath, UnboundNewPath } from './init-outcome.ts';
import {
  assertDryRunOptions,
  type InitIntent,
  type MonorepoRootOption,
  parseMonorepoRoots,
  type UnboundNewOptions,
  validateIntentOptions,
  validateScanOptions,
  validateUnboundNewOptions,
  warnIgnoredIntent,
  warnIgnoredScanOptions,
  warnIgnoredUnboundNewOptions,
} from './options.ts';
import { renderInitOutcome } from './output.ts';
import { resolveInitAuth } from './steps/auth.ts';
import { runBoundNew } from './steps/bind.ts';
import { type DetectDeps, detectInitPath, resolveProjectRoot } from './steps/detect.ts';
import { pickFolders } from './steps/folder-selection.ts';
import { offerIntegrate } from './steps/integrate.ts';
import { runLinkExisting } from './steps/link-existing.ts';
import { findLinkedProjectIssues, isUnavailable } from './steps/linked-projects.ts';
import { runMonorepo } from './steps/monorepo.ts';
import { OrganizationCreationDeclined } from './steps/organization.ts';
import {
  NOT_RUN,
  reportScan,
  runFirstScan,
  type ScanOptions,
  type ScanResult,
} from './steps/scan.ts';
import { runUnboundNew } from './steps/unbound.ts';

export interface InitOptions {
  path?: string;
  nonInteractive?: boolean;
  monorepo?: boolean;
  root?: string[];
  /** `true` for a bare `--link`, the key for `--link <key>`. */
  link?: string | boolean;
  bind?: boolean;
  create?: boolean;
  project?: string;
  name?: string;
  visibility?: string;
  scannerProperty?: string[];
  verbose?: boolean;
  detach?: boolean;
  scan?: boolean;
  dryRun?: boolean;
}

/**
 * Signs in, resolves the organization, detects the project and selects the onboarding path.
 * It runs `bound-new`, `link-existing` and `unbound-new`. It keeps everything it completed:
 * running it again resumes from whatever is already in place.
 */
export async function init(options: InitOptions, ctx: CommandInvocationContext): Promise<void> {
  const interactive = !options.nonInteractive && ctx.console.canPrompt();
  const { console } = ctx;

  const monorepoRoots = parseMonorepoRoots(options.root);
  if (monorepoRoots.length > 0 && !options.monorepo) {
    throw new InvalidOptionError('--root only applies together with --monorepo.');
  }

  const intent = validateIntentOptions(options);
  const projectRoot = resolveProjectRoot(options.path ?? '.');
  const unboundNewOptions = validateUnboundNewOptions(options);
  const scanOptions = validateScanOptions(options);
  const dryRun = options.dryRun === true;
  if (dryRun) {
    assertDryRunOptions(scanOptions);
    console.info('DRY RUN: no changes will be made.');
  }

  const { outcome, auth, deps } = await run(projectRoot, ctx, console, {
    interactive,
    dryRun,
    intent,
    unboundNewOptions,
    monorepo: options.monorepo === true,
    monorepoRoots,
    pathGiven: options.path !== undefined,
  });
  if (outcome.kind === 'complete') {
    warnIgnoredIntent(intent, console);
  }
  const declined = outcome.kind === 'declined' || outcome.kind === 'no-organization';
  // A dry run that would create the project uses these options just as the real run does.
  const createsUnbound =
    outcome.kind === 'unbound' || (outcome.kind === 'dry-run' && outcome.action.type === 'create');
  if (!createsUnbound && !declined) {
    warnIgnoredUnboundNewOptions(unboundNewOptions, console);
  }
  const scan = await scanCreatedProject(outcome, projectRoot, deps, scanOptions);
  if (scan.status === 'not-run') {
    warnIgnoredScanOptions(scanOptions, console);
  }
  renderInitOutcome(outcome, auth, console, dryRun);
  if (dryRun) {
    console.info('Dry run: nothing was written. Run without --dry-run to apply.');
    return;
  }
  // Without a session (the user declined to create an organization) there is nothing to integrate with.
  if (interactive && auth && findInstalledIntegrationIds().length === 0) {
    await offerIntegrate(ctx, auth);
  }
}

/** Only a project this run created gets a first analysis; a linked or bound one already has results. */
async function scanCreatedProject(
  outcome: InitOutcome,
  projectRoot: string,
  deps: DetectDeps | undefined,
  options: ScanOptions,
): Promise<ScanResult> {
  if (outcome.kind !== 'unbound' || !deps) {
    return NOT_RUN;
  }
  const scan = await runFirstScan(projectRoot, outcome.projectKey, deps, options);
  reportScan(scan, outcome.projectKey, deps.console);
  return scan;
}

interface RunSettings {
  interactive: boolean;
  dryRun: boolean;
  intent: InitIntent | undefined;
  unboundNewOptions: UnboundNewOptions;
  monorepo: boolean;
  monorepoRoots: readonly MonorepoRootOption[];
  /** `--path` fixed the directory, so there is no folder to choose. */
  pathGiven: boolean;
}

interface RunResult {
  outcome: InitOutcome;
  auth?: ResolvedAuth;
  deps?: DetectDeps;
}

async function run(
  projectRoot: string,
  ctx: CommandInvocationContext,
  console: Console,
  settings: RunSettings,
): Promise<RunResult> {
  const { interactive, dryRun, intent, unboundNewOptions, monorepo, monorepoRoots } = settings;
  let auth: ResolvedAuth;
  try {
    auth = await resolveInitAuth(ctx, interactive, dryRun);
  } catch (error) {
    if (error instanceof OrganizationCreationDeclined) {
      return { outcome: { kind: 'no-organization' } };
    }
    throw error;
  }
  const http = new SonarHttpClient(auth.serverUrl, auth.token);
  const deps: DetectDeps = { auth, http, console, interactive, dryRun, intent };
  if (monorepo) {
    const roots = await monorepoRootsToOnboard(projectRoot, monorepoRoots, deps, interactive);
    const linkOnly = intent?.kind === 'link';
    return { outcome: await runMonorepo(projectRoot, deps, roots, linkOnly), auth, deps };
  }
  // The folders are asked about only once the user agrees to link, so the steps do the asking.
  const pickingDeps: DetectDeps = askFolders(settings, intent)
    ? { ...deps, onboardPickedFolders: (roots) => runMonorepo(projectRoot, deps, roots) }
    : deps;
  const detected = await detectInitPath(projectRoot, pickingDeps);
  return { outcome: await runDetectedPath(detected, pickingDeps, unboundNewOptions), auth, deps };
}

/** Without `--root`, an interactive `--monorepo` run asks which folders to onboard. */
async function monorepoRootsToOnboard(
  projectRoot: string,
  named: readonly MonorepoRootOption[],
  deps: DetectDeps,
  interactive: boolean,
): Promise<readonly MonorepoRootOption[]> {
  if (named.length > 0 || !interactive) {
    return named;
  }
  try {
    const selection = await pickFolders(projectRoot, true, deps);
    return selection?.kind === 'monorepo' ? selection.roots : named;
  } catch (error) {
    throw error instanceof FolderSelectionCancelledError ? new OnboardingCancelledError() : error;
  }
}

/** Interactive, and neither `--path`, a project key nor `--root` already says which folder to link. */
function askFolders(
  { interactive, pathGiven, unboundNewOptions }: RunSettings,
  intent: InitIntent | undefined,
): boolean {
  const keyGiven =
    unboundNewOptions.projectKey !== undefined ||
    (intent?.kind === 'link' && intent.projectKey !== undefined);
  return interactive && !pathGiven && !keyGiven;
}

/**
 * `bound-new` and `link-existing` hand back `unbound-new` only when the user declined binding or
 * linking, so it continues into the project creation.
 */
async function runDetectedPath(
  detected: InitPath,
  deps: DetectDeps,
  unboundNewOptions: UnboundNewOptions,
): Promise<InitOutcome> {
  switch (detected.path) {
    case 'bound-new':
      return fallBack(await runBoundNew(detected, deps), deps, unboundNewOptions);
    case 'link-existing':
      return fallBack(await runLinkExisting(detected, deps), deps, unboundNewOptions);
    case 'unbound-new':
      return runUnboundNew(detected, deps, unboundNewOptions);
    case 'complete':
      return checkCompleteLinks(detected, deps);
  }
}

/** The file says the directory is set up; the remote may disagree, which is reported but never repaired. */
async function checkCompleteLinks(
  { projectRoot, projects }: Extract<InitPath, { path: 'complete' }>,
  deps: DetectDeps,
): Promise<InitOutcome> {
  const issues = await findLinkedProjectIssues(
    projects.map((project) => ({
      projectKey: project.projectKey,
      path: relativeProjectPath(projectRoot, project.projectRoot),
    })),
    deps,
  );
  const unavailable = new Set(issues.filter(isUnavailable).map(({ projectKey }) => projectKey));
  const projectKeys = projects
    .map(({ projectKey }) => projectKey)
    .filter((projectKey) => !unavailable.has(projectKey));
  return { kind: 'complete', projectKeys, issues };
}

function fallBack(
  result: InitOutcome | UnboundNewPath,
  deps: DetectDeps,
  unboundNewOptions: UnboundNewOptions,
): InitOutcome | Promise<InitOutcome> {
  return 'kind' in result ? result : runUnboundNew(result, deps, unboundNewOptions);
}
