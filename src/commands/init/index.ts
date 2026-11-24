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

import { resolve } from 'node:path';

import { findInstalledIntegrationIds } from '@/commands/integrate/_common/installed-integrations.ts';
import { FolderSelectionCancelledError } from '@/commands/link/choose-folder.ts';
import {
  chooseProjectKey,
  ProjectSelectionCancelledError,
} from '@/commands/link/choose-project.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { findGitRoot, getGitRemote } from '@/core/host/git/discover.ts';
import { relativeProjectPath } from '@/core/project-discovery/link-target.ts';
import { stripGitRemoteUrlUserinfo } from '@/core/server/git-remote-url.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import type { Console } from '@/core/ui/console.ts';

import { OnboardingCancelledError } from './answer.ts';
import type { InitOutcome, InitPath, NoProjectPath } from './init-outcome.ts';
import {
  type InitIntent,
  type MonorepoRootOption,
  parseMonorepoRoots,
  validateIntentOptions,
  warnIgnoredIntent,
} from './options.ts';
import { renderInitOutcome } from './output.ts';
import { classifyRemoteHost } from './remote-host.ts';
import { resolveInitAuth } from './steps/auth.ts';
import { runBoundNew } from './steps/bind.ts';
import { type DetectDeps, detectInitPath, resolveProjectRoot } from './steps/detect.ts';
import { pickFolders } from './steps/folder-selection.ts';
import { offerIntegrate } from './steps/integrate.ts';
import { runLinkExisting } from './steps/link-existing.ts';
import { findLinkedProjectIssues, isUnavailable } from './steps/linked-projects.ts';
import { runMonorepo } from './steps/monorepo.ts';
import { runNoProject } from './steps/no-project.ts';
import { OrganizationCreationDeclined } from './steps/organization.ts';
import type { InitPathId } from './telemetry/init-telemetry.ts';
import {
  type InitRunContext,
  InitTelemetryRecorder,
  type ProjectInitRecorder,
} from './telemetry/init-telemetry-recorder.ts';

export interface InitOptions {
  path?: string;
  nonInteractive?: boolean;
  monorepo?: boolean;
  root?: string[];
  /** `true` for a bare `--link`, the key for `--link <key>`. */
  link?: string | boolean;
  bind?: boolean;
  dryRun?: boolean;
}

/**
 * Signs in, resolves the organization, detects the project and selects the onboarding path.
 * It runs `bound-new`, `link-existing` and `no-project`. It keeps everything it completed:
 * running it again resumes from whatever is already in place.
 */
export async function init(options: InitOptions, ctx: CommandInvocationContext): Promise<void> {
  const interactive = !options.nonInteractive && ctx.console.canPrompt();
  const dryRun = options.dryRun === true;
  const telemetry = new InitTelemetryRecorder(options.monorepo === true);
  const session: { auth?: ResolvedAuth } = {};
  try {
    await onboard(options, ctx, { interactive, dryRun, telemetry, session });
  } catch (error) {
    telemetry.fail(error);
    throw error;
  } finally {
    // A preview changes nothing, so it would only blur what onboarding runs reach.
    if (!dryRun) {
      const repository = await describeRun(options.path, interactive, session.auth);
      await telemetry.emit(ctx, repository);
    }
  }
}

interface OnboardSettings {
  interactive: boolean;
  dryRun: boolean;
  telemetry: InitTelemetryRecorder;
  /** Filled once signed in, so the telemetry of a failed run still carries the connection. */
  session: { auth?: ResolvedAuth };
}

async function onboard(
  options: InitOptions,
  ctx: CommandInvocationContext,
  { interactive, dryRun, telemetry, session }: OnboardSettings,
): Promise<void> {
  const { console } = ctx;

  const monorepoRoots = parseMonorepoRoots(options.root);
  if (monorepoRoots.length > 0 && !options.monorepo) {
    throw new InvalidOptionError('--root only applies together with --monorepo.');
  }

  const intent = validateIntentOptions(options);
  const projectRoot = resolveProjectRoot(options.path ?? '.');
  if (dryRun) {
    console.info('DRY RUN: no changes will be made.');
  }

  const { outcome, auth } = await run(projectRoot, ctx, console, {
    interactive,
    dryRun,
    intent,
    monorepo: options.monorepo === true,
    monorepoRoots,
    pathGiven: options.path !== undefined,
    telemetry,
    session,
  });
  if (outcome.kind === 'complete') {
    warnIgnoredIntent(intent, console);
  }
  if (outcome.kind === 'declined') {
    telemetry.stopAtDeclined();
  }
  renderInitOutcome(outcome, auth, console, dryRun);
  if (dryRun) {
    console.info('Dry run: nothing was written. Run without --dry-run to apply.');
    return;
  }
  await offerIntegrateStep(ctx, auth, interactive, telemetry);
}

/** Without a session (the user declined to create an organization) there is nothing to integrate with. */
async function offerIntegrateStep(
  ctx: CommandInvocationContext,
  auth: ResolvedAuth | undefined,
  interactive: boolean,
  telemetry: InitTelemetryRecorder,
): Promise<void> {
  if (!interactive || !auth) {
    telemetry.record('integrate', 'skipped');
    return;
  }
  if (findInstalledIntegrationIds().length > 0) {
    telemetry.record('integrate', 'already_done');
    return;
  }
  telemetry.begin('integrate');
  telemetry.record('integrate', await offerIntegrate(ctx, auth));
}

/** The repository facts the run event carries; any lookup failure leaves them out. */
async function describeRun(
  pathOption: string | undefined,
  isInteractive: boolean,
  auth: ResolvedAuth | undefined,
): Promise<InitRunContext> {
  try {
    const { gitRoot, isGit } = findGitRoot(resolve(process.cwd(), pathOption ?? '.'));
    if (!isGit) {
      return { auth, isInteractive, remoteHost: null, repoRoot: null };
    }
    const remote = await getGitRemote(gitRoot);
    return {
      auth,
      isInteractive,
      remoteHost: classifyRemoteHost(remote ? stripGitRemoteUrlUserinfo(remote) : undefined),
      repoRoot: gitRoot,
    };
  } catch {
    return { auth, isInteractive, remoteHost: null, repoRoot: null };
  }
}

interface RunSettings {
  interactive: boolean;
  dryRun: boolean;
  intent: InitIntent | undefined;
  monorepo: boolean;
  monorepoRoots: readonly MonorepoRootOption[];
  /** `--path` fixed the directory, so there is no folder to choose. */
  pathGiven: boolean;
  telemetry: InitTelemetryRecorder;
  session: { auth?: ResolvedAuth };
}

interface RunResult {
  outcome: InitOutcome;
  auth?: ResolvedAuth;
}

async function run(
  projectRoot: string,
  ctx: CommandInvocationContext,
  console: Console,
  settings: RunSettings,
): Promise<RunResult> {
  const { interactive, dryRun, intent, monorepo, monorepoRoots, telemetry } = settings;
  let auth: ResolvedAuth;
  try {
    auth = await resolveInitAuth(ctx, interactive, dryRun, telemetry);
  } catch (error) {
    if (error instanceof OrganizationCreationDeclined) {
      telemetry.stopAt('create_org', 'no_org');
      return { outcome: { kind: 'no-organization' } };
    }
    throw error;
  }
  settings.session.auth = auth;
  const http = new SonarHttpClient(auth.serverUrl, auth.token);
  const deps: DetectDeps = {
    auth,
    http,
    console,
    interactive,
    dryRun,
    intent,
    telemetry,
  };
  telemetry.begin('detect');
  if (monorepo) {
    const roots = await monorepoRootsToOnboard(projectRoot, monorepoRoots, deps, interactive);
    const linkOnly = intent?.kind === 'link';
    const monorepoDeps: DetectDeps =
      linkOnly && interactive ? { ...deps, chooseProject: projectChooser(ctx, auth) } : deps;
    const outcome = await runMonorepo(projectRoot, monorepoDeps, roots, linkOnly);
    if (outcome.kind === 'no-monorepo-roots') {
      telemetry.record('detect', 'failed');
      telemetry.stopAt('detect', 'unknown');
    }
    return { outcome, auth };
  }
  // The folders are asked about only once the user agrees to link, so the steps do the asking.
  const pickingDeps: DetectDeps = askFolders(settings, intent)
    ? { ...deps, pickLinkFolder: true }
    : deps;
  const detected = await detectInitPath(projectRoot, pickingDeps);
  const project = telemetry.detected(initPathIdOf(detected));
  if (detected.path === 'no-project' && !project.has('project_bind')) {
    project.record('project_bind', 'skipped');
  }
  return { outcome: await runDetectedPath(detected, pickingDeps, project), auth };
}

function initPathIdOf(detected: InitPath): InitPathId {
  switch (detected.path) {
    case 'complete':
      return 'already_done';
    case 'link-existing':
      return 'link_existing';
    case 'bound-new':
      return 'bound_new';
    case 'no-project':
      return 'no_project';
  }
}

/** The project prompts of `sonar link`, with leaving them ending the onboarding. */
function projectChooser(
  ctx: CommandInvocationContext,
  auth: ResolvedAuth,
): NonNullable<DetectDeps['chooseProject']> {
  const authenticated = ctx.withAuth(auth);
  return async (projectRoot, items) => {
    try {
      return await chooseProjectKey(projectRoot, true, items, authenticated);
    } catch (error) {
      throw error instanceof ProjectSelectionCancelledError
        ? new OnboardingCancelledError()
        : error;
    }
  };
}

/**
 * Without `--root`, an interactive `--monorepo` run asks which folders to onboard. Nothing is
 * pre-ticked: `runMonorepo` reports the roots `.sonar-config.json` maps that the user leaves unticked.
 */
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
    return selection.kind === 'monorepo' ? selection.roots : named;
  } catch (error) {
    throw error instanceof FolderSelectionCancelledError ? new OnboardingCancelledError() : error;
  }
}

/** Interactive, and neither `--path`, a project key nor `--root` already says which folder to link. */
function askFolders(
  { interactive, pathGiven }: RunSettings,
  intent: InitIntent | undefined,
): boolean {
  const keyGiven = intent?.kind === 'link' && intent.projectKey !== undefined;
  return interactive && !pathGiven && !keyGiven;
}

/** `bound-new` hands back `no-project` only when the user declined the DevOps platform authorization. */
async function runDetectedPath(
  detected: InitPath,
  deps: DetectDeps,
  project: ProjectInitRecorder,
): Promise<InitOutcome> {
  switch (detected.path) {
    case 'bound-new':
      return fallBack(await runBoundNew(detected, deps), deps, project);
    case 'link-existing': {
      project.begin('link');
      const result = await runLinkExisting(detected, deps);
      recordLinkResult(result, project);
      return result;
    }
    case 'no-project':
      return noProject(detected, deps, project);
    case 'complete': {
      const outcome = await checkCompleteLinks(detected, deps);
      project.record('link', 'already_done');
      const [projectKey] = outcome.projectKeys;
      if (projectKey) {
        project.setProjectKey(projectKey);
      }
      return outcome;
    }
  }
}

function recordLinkResult(result: InitOutcome, project: ProjectInitRecorder): void {
  if (result.kind === 'declined') {
    project.record('link', 'declined');
  } else if (result.kind === 'linked') {
    project.record('link', 'success');
    project.setProjectKey(result.projectKey);
  }
}

/** Resolve an existing project without attempting creation. */
async function noProject(
  path: NoProjectPath,
  deps: DetectDeps,
  project: ProjectInitRecorder,
): Promise<InitOutcome> {
  project.setPath('no_project');
  project.begin('link');
  const { outcome, offeredLink } = await runNoProject(path, deps);
  if (outcome.kind === 'linked') {
    // The generated key named a project, and the user linked it.
    project.setPath('link_existing');
    project.record('link', 'success');
    project.setProjectKey(outcome.projectKey);
  } else if (outcome.kind === 'declined') {
    if (offeredLink) {
      // The generated key named a project, and the user turned the link down.
      project.setPath('link_existing');
      project.record('link', 'declined');
    } else {
      project.record('link', 'skipped');
    }
  }
  return outcome;
}

/** The file says the directory is set up; the remote may disagree, which is reported but never repaired. */
async function checkCompleteLinks(
  { projectRoot, projects }: Extract<InitPath, { path: 'complete' }>,
  deps: DetectDeps,
): Promise<Extract<InitOutcome, { kind: 'complete' }>> {
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
  result: InitOutcome | NoProjectPath,
  deps: DetectDeps,
  project: ProjectInitRecorder,
): InitOutcome | Promise<InitOutcome> {
  return 'kind' in result ? result : noProject(result, deps, project);
}
