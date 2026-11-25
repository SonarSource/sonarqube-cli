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

import { FolderSelectionCancelledError } from '@/commands/link/choose-folder.ts';
import {
  chooseProjectKey,
  ProjectSelectionCancelledError,
} from '@/commands/link/choose-project.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { findGitRoot, getGitRemote } from '@/core/host/git/discover.ts';
import { stripGitRemoteUrlUserinfo } from '@/core/server/git-remote-url.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import type { Console } from '@/core/ui/console.ts';

import { OnboardingCancelledError } from './answer.ts';
import { singleRoot, StepRunner } from './flow/step-runner.ts';
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
import { LoginStep } from './steps/auth.ts';
import { runBoundNew } from './steps/bind.ts';
import { CompleteLinkStep } from './steps/complete-link.ts';
import { type DetectDeps, DetectStep, resolveProjectRoot } from './steps/detect.ts';
import { pickFolders } from './steps/folder-selection.ts';
import { IntegrateStep } from './steps/integrate.ts';
import { LinkExistingStep } from './steps/link-existing.ts';
import { runMonorepo } from './steps/monorepo.ts';
import { NoProjectStep } from './steps/no-project.ts';
import { type InitRunContext, InitTelemetryRecorder } from './telemetry/init-telemetry-recorder.ts';

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
  const steps = new StepRunner(telemetry);
  const session: { auth?: ResolvedAuth } = {};
  try {
    await onboard(options, ctx, { interactive, dryRun, steps, session });
  } catch (error) {
    telemetry.failRun(error);
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
  steps: StepRunner;
  /** Filled once signed in, so the telemetry of a failed run still carries the connection. */
  session: { auth?: ResolvedAuth };
}

async function onboard(
  options: InitOptions,
  ctx: CommandInvocationContext,
  { interactive, dryRun, steps, session }: OnboardSettings,
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
    steps,
    session,
  });
  if (outcome.kind === 'complete') {
    warnIgnoredIntent(intent, console);
  }
  renderInitOutcome(outcome, auth, console, dryRun);
  if (dryRun) {
    console.info('Dry run: nothing was written. Run without --dry-run to apply.');
    return;
  }
  await steps.run(new IntegrateStep(ctx, auth, interactive));
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
  steps: StepRunner;
  session: { auth?: ResolvedAuth };
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
  const { interactive, dryRun, intent, monorepo, monorepoRoots, steps } = settings;
  const auth = await steps.run(new LoginStep(ctx, interactive, dryRun, steps));
  if (!auth) {
    return { outcome: { kind: 'no-organization' } };
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
    steps,
    root: singleRoot(projectRoot),
  };
  if (monorepo) {
    const roots = await monorepoRootsToOnboard(projectRoot, monorepoRoots, deps, interactive);
    const linkOnly = intent?.kind === 'link';
    const monorepoDeps: DetectDeps =
      linkOnly && interactive ? { ...deps, chooseProject: projectChooser(ctx, auth) } : deps;
    return { outcome: await runMonorepo(projectRoot, monorepoDeps, roots, linkOnly), auth };
  }
  // The folders are asked about only once the user agrees to link, so the steps do the asking.
  const pickingDeps: DetectDeps = askFolders(settings, intent)
    ? { ...deps, pickLinkFolder: true }
    : deps;
  const [detected] = await steps.run(new DetectStep(projectRoot, pickingDeps));
  return {
    outcome: await runDetectedPath(detected.target, pickingDeps),
    auth,
    deps,
  };
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
async function runDetectedPath(detected: InitPath, deps: DetectDeps): Promise<InitOutcome> {
  switch (detected.path) {
    case 'bound-new':
      return fallBack(await runBoundNew(detected, deps), deps);
    case 'link-existing':
      return deps.steps.run(new LinkExistingStep(detected, deps));
    case 'no-project':
      return deps.steps.run(new NoProjectStep(detected, deps));
    case 'complete':
      return deps.steps.run(new CompleteLinkStep(detected, deps));
  }
}

function fallBack(
  result: InitOutcome | NoProjectPath,
  deps: DetectDeps,
): InitOutcome | Promise<InitOutcome> {
  return 'kind' in result ? result : deps.steps.run(new NoProjectStep(result, deps));
}
