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

// Binds the new roots of a monorepo to the repository with one `import --monorepo` call.

import { CloudBackend } from '@/commands/import/cloud-backend.ts';
import { ImportApiClient } from '@/commands/import/import-api.ts';
import type { ImportPlan } from '@/commands/import/import-backend.ts';
import { resolveAlmKey, type ResolvedOrg, resolveOrg } from '@/commands/import/resolve-options.ts';
import { QuietConsole } from '@/core/ui/quiet-console.ts';

import { requireAnswer } from '../answer.ts';
import { SettledStep } from '../flow/settled-step.ts';
import type { InitStepOutcome } from '../flow/step-ids.ts';
import { failed, skipped, type StepResult, success } from '../flow/step-result.ts';
import type { InitRoot, InitStep, StepRef } from '../flow/step-runner.ts';
import type { MonorepoRootResult } from '../init-outcome.ts';
import { remoteRepositorySlug } from '../remote-host.ts';
import { OrgBindStep } from './bind.ts';
import type { DetectDeps } from './detect.ts';
import { describeFailure, isRunFatal } from './linked-projects.ts';
import { writeMapping } from './mapping.ts';

/** A root whose project does not exist yet, with the project to create for it. */
export interface BindableRoot {
  root: InitRoot;
  /** Relative to the repository root, for display and the summary. */
  path: string;
  projectRoot: string;
  projectKey: string;
  projectName: string;
}

/**
 * The repository slug the new roots can be bound through, or null when they cannot be: binding
 * needs SonarQube Cloud, a GitHub or Azure DevOps remote, and a terminal to ask on, unless
 * `--bind` already gave the consent.
 */
function bindableSlug(
  remote: string | undefined,
  { auth, interactive, intent }: DetectDeps,
): string | null {
  if (!remote || (!interactive && intent?.kind !== 'bind') || auth.connectionType !== 'cloud') {
    return null;
  }
  return remoteRepositorySlug(remote);
}

/** Nothing runs for these roots, yet their creation ends here: each root's `create_project` records how. */
function settleCreations(
  roots: readonly BindableRoot[],
  { steps }: DetectDeps,
  resultOf: (root: BindableRoot) => StepResult<MonorepoRootResult>,
): Promise<MonorepoRootResult[]> {
  return roots.reduce<Promise<MonorepoRootResult[]>>(async (previous, root) => {
    const done = await previous;
    done.push(
      await steps.run(new SettledStep({ step: 'create_project', root: root.root }, resultOf(root))),
    );
    return done;
  }, Promise.resolve([]));
}

function allFailed(
  roots: readonly BindableRoot[],
  deps: DetectDeps,
  reason: string,
  cause?: unknown,
): Promise<MonorepoRootResult[]> {
  return settleCreations(roots, deps, ({ path }) =>
    failed({ path, kind: 'failed', reason }, cause),
  );
}

/** One question binds every root, so each root's `project_bind` step ends with its answer. */
async function settleBindDecision(
  roots: readonly BindableRoot[],
  { steps }: DetectDeps,
  outcome: InitStepOutcome,
): Promise<void> {
  for (const { root } of roots) {
    await steps.run(new SettledStep({ step: 'project_bind', root }, { outcome, value: undefined }));
  }
}

/**
 * Provisions every root through one batched import. A repository takes its monorepo binding once,
 * so this never runs per root. Resolves to each root's result, or to undefined when the roots are
 * not bound: the user declined, or the repository cannot be bound.
 */
export async function bindNewRoots(
  roots: readonly BindableRoot[],
  remote: string | undefined,
  deps: DetectDeps,
): Promise<MonorepoRootResult[] | undefined> {
  if (roots.length === 0) {
    return undefined;
  }
  // `--bind` is the consent to bind, so what it cannot do is reported as a failure.
  const required = deps.intent?.kind === 'bind';
  const slug = bindableSlug(remote, deps);
  if (slug === null) {
    await settleBindDecision(roots, deps, required ? 'failed' : 'skipped');
    return required
      ? allFailed(
          roots,
          deps,
          '--bind is unavailable: it needs SonarQube Cloud and a GitHub or Azure DevOps git remote. Nothing was created.',
        )
      : undefined;
  }
  const { auth, http, console, dryRun } = deps;
  const noun = roots.length === 1 ? 'project' : 'projects';
  const consent =
    required ||
    requireAnswer(
      await console.confirmPrompt(
        `Bind the ${roots.length} new ${noun} to the repository '${slug}'?`,
        true,
      ),
    );
  await settleBindDecision(roots, deps, consent ? 'success' : 'declined');
  if (!consent) {
    return undefined;
  }

  const api = new ImportApiClient(http);
  const org = await resolveOrg(api, auth.orgKey);
  const linkedAlmKey = await resolveAlmKey(api, org.key, org.almKey);
  // The browser authorization and the import both change things, so a preview stops short of them.
  if (dryRun) {
    if (!linkedAlmKey) {
      console.info(
        `Organization '${org.key}' is not linked to your DevOps platform yet: that would first be authorized in the browser.`,
      );
    }
    return settleCreations(roots, deps, ({ path, projectKey }) =>
      skipped({ path, kind: 'would-bind', projectKey }),
    );
  }
  // One authorization serves every root: the batch below reuses the key it returns.
  const almKey = await deps.steps.run(new OrgBindStep(linkedAlmKey, api, auth, org.key, deps));
  if (!almKey) {
    return required
      ? allFailed(roots, deps, 'The organization authorization was declined. Nothing was created.')
      : undefined;
  }
  return importBatch(roots, slug, noun, { ...org, almKey }, api, deps);
}

async function importBatch(
  roots: readonly BindableRoot[],
  slug: string,
  noun: string,
  org: ResolvedOrg,
  api: ImportApiClient,
  deps: DetectDeps,
): Promise<MonorepoRootResult[]> {
  const { auth, console } = deps;
  let plan: ImportPlan;
  try {
    // A repository that already has bound projects may take more: that is what `import --monorepo` does.
    plan = await new CloudBackend(api, auth.orgKey, auth.serverUrl, org).plan(
      { repo: [slug], nonInteractive: true, allowImportedRepo: true },
      new QuietConsole(console),
    );
  } catch (error) {
    if (isRunFatal(error)) {
      throw error;
    }
    // The repository cannot be imported at all, which every root shares; the summary says so per root.
    return allFailed(roots, deps, describeFailure(error), error);
  }
  const { selection } = plan;
  if (selection.kind !== 'batch' || selection.repos.length !== 1) {
    const reason = selection.kind === 'batch' ? selection.skipped[0]?.reason : undefined;
    const detail = reason ? `: ${reason}` : '.';
    return allFailed(
      roots,
      deps,
      `Repository '${slug}' cannot be bound${detail} Nothing was created.`,
    );
  }

  const verdicts = new Map<string, { done: boolean; detail?: string }>();
  await console.withSpinner(`Binding ${roots.length} ${noun} to '${slug}'`, () =>
    plan.importMonorepo(
      selection.repos[0],
      roots.map(({ projectKey, projectName }) => ({ projectKey, projectName })),
      (projectKey, status, detail) => {
        if (status !== 'running') {
          verdicts.set(projectKey, { done: status === 'done', detail });
        }
      },
    ),
  );

  // Mappings are merged one at a time: each is a read-modify-write of the same file.
  return roots.reduce<Promise<MonorepoRootResult[]>>(async (previous, root) => {
    const results = await previous;
    results.push(
      await deps.steps.run(new MapBoundRootStep(root, slug, verdicts.get(root.projectKey), deps)),
    );
    return results;
  }, Promise.resolve([]));
}

/** A root the batched import created: writing its mapping ends its `create_project` step. */
class MapBoundRootStep implements InitStep<MonorepoRootResult> {
  readonly ref: StepRef;

  constructor(
    private readonly target: BindableRoot,
    private readonly slug: string,
    private readonly verdict: { done: boolean; detail?: string } | undefined,
    private readonly deps: DetectDeps,
  ) {
    this.ref = { step: 'create_project', root: target.root };
  }

  async run(): Promise<StepResult<MonorepoRootResult>> {
    const { path, projectRoot, projectKey } = this.target;
    const { slug, verdict } = this;
    const { auth, console } = this.deps;

    if (!verdict?.done) {
      return failed({
        path,
        kind: 'failed',
        reason: verdict?.detail ?? `The import did not report project '${projectKey}'.`,
      });
    }
    try {
      await writeMapping(auth, projectKey, projectRoot, console, 'created', true);
      console.success(`Created project '${projectKey}' bound to '${slug}' for ${path}.`);
      return success({ path, kind: 'bound', projectKey }, { projectKey, initPath: 'bound_new' });
    } catch (error) {
      if (isRunFatal(error)) {
        throw error;
      }
      return failed({ path, kind: 'failed', reason: describeFailure(error) }, error);
    }
  }
}
