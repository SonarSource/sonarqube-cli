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
import { declined, failed, skipped, type StepResult, success } from '../flow/step-result.ts';
import type { InitRoot, InitStep, StepRef } from '../flow/step-runner.ts';
import { remoteRepositorySlug } from '../remote-host.ts';
import { OrgBindStep } from './bind.ts';
import type { DetectDeps } from './detect.ts';
import { describeFailure, isRunFatal } from './linked-projects.ts';

/** A root whose project does not exist yet, with the project to create for it. */
export interface BindableRoot {
  root: InitRoot;
  projectKey: string;
  projectName: string;
}

/** What the one question settled for every new root. */
type BindDecision =
  { kind: 'unbindable' } | { kind: 'declined' } | { kind: 'consented'; slug: string };

/** What the import reported for one project. */
export interface ImportVerdict {
  done: boolean;
  detail?: string;
}

/** What the batched import did for every new root; each root's creation step reads its part. */
export type BatchImport =
  /** Nothing was created, for a reason every root shares. */
  | { kind: 'failed'; reason: string; cause?: unknown }
  /** `--dry-run`: the projects would be created bound to the repository. */
  | { kind: 'previewed' }
  | { kind: 'imported'; slug: string; verdicts: ReadonlyMap<string, ImportVerdict> };

const BIND_UNAVAILABLE =
  '--bind is unavailable: it needs SonarQube Cloud and a GitHub or Azure DevOps git remote. Nothing was created.';

/**
 * Asks once whether to bind every new root, records each root's `project_bind`, then provisions
 * them through one batched import. A repository takes its monorepo binding once, so this never
 * runs per root. Resolves to undefined when the roots are not bound: the user declined, or the
 * repository cannot be bound and `--bind` did not require it.
 */
export async function bindNewRoots(
  roots: readonly BindableRoot[],
  remote: string | undefined,
  deps: DetectDeps,
): Promise<BatchImport | undefined> {
  if (roots.length === 0) {
    return undefined;
  }
  // `--bind` is the consent to bind, so what it cannot do is reported as a failure.
  const required = deps.intent?.kind === 'bind';
  const decision = await decideBinding(roots.length, remote, deps);
  for (const { root } of roots) {
    await deps.steps.run(new RootBindStep(root, decision, required));
  }
  switch (decision.kind) {
    case 'unbindable':
      return required ? { kind: 'failed', reason: BIND_UNAVAILABLE } : undefined;
    case 'declined':
      return undefined;
    case 'consented':
      return importRoots(roots, decision.slug, required, deps);
  }
}

/**
 * Binding needs SonarQube Cloud, a GitHub or Azure DevOps remote, and a terminal to ask on,
 * unless `--bind` already gave the consent.
 */
async function decideBinding(
  count: number,
  remote: string | undefined,
  { auth, console, interactive, intent }: DetectDeps,
): Promise<BindDecision> {
  const required = intent?.kind === 'bind';
  const slug =
    remote && (interactive || required) && auth.connectionType === 'cloud'
      ? remoteRepositorySlug(remote)
      : null;
  if (slug === null) {
    return { kind: 'unbindable' };
  }
  const consent =
    required ||
    requireAnswer(
      await console.confirmPrompt(
        `Bind the ${count} new ${projectNoun(count)} to the repository '${slug}'?`,
        true,
      ),
    );
  return consent ? { kind: 'consented', slug } : { kind: 'declined' };
}

function projectNoun(count: number): string {
  return count === 1 ? 'project' : 'projects';
}

/** A root's `project_bind` ends with the answer given for every root. */
class RootBindStep implements InitStep<undefined> {
  readonly ref: StepRef;

  constructor(
    root: InitRoot,
    private readonly decision: BindDecision,
    private readonly required: boolean,
  ) {
    this.ref = { step: 'project_bind', root };
  }

  run(): Promise<StepResult<undefined>> {
    return Promise.resolve(this.result());
  }

  private result(): StepResult<undefined> {
    switch (this.decision.kind) {
      case 'unbindable':
        return this.required ? failed(undefined) : skipped(undefined);
      case 'declined':
        return declined(undefined);
      case 'consented':
        return success(undefined);
    }
  }
}

async function importRoots(
  roots: readonly BindableRoot[],
  slug: string,
  required: boolean,
  deps: DetectDeps,
): Promise<BatchImport | undefined> {
  const { auth, http, console, dryRun } = deps;
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
    return { kind: 'previewed' };
  }
  // One authorization serves every root: the batch below reuses the key it returns.
  const almKey = await deps.steps.run(new OrgBindStep(linkedAlmKey, api, auth, org.key, deps));
  if (!almKey) {
    return required
      ? {
          kind: 'failed',
          reason: 'The organization authorization was declined. Nothing was created.',
        }
      : undefined;
  }
  return importBatch(roots, slug, { ...org, almKey }, api, deps);
}

async function importBatch(
  roots: readonly BindableRoot[],
  slug: string,
  org: ResolvedOrg,
  api: ImportApiClient,
  { auth, console }: DetectDeps,
): Promise<BatchImport> {
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
    return { kind: 'failed', reason: describeFailure(error), cause: error };
  }
  const { selection } = plan;
  if (selection.kind !== 'batch' || selection.repos.length !== 1) {
    const reason = selection.kind === 'batch' ? selection.skipped[0]?.reason : undefined;
    const detail = reason ? `: ${reason}` : '.';
    return {
      kind: 'failed',
      reason: `Repository '${slug}' cannot be bound${detail} Nothing was created.`,
    };
  }

  const verdicts = new Map<string, ImportVerdict>();
  const noun = projectNoun(roots.length);
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
  return { kind: 'imported', slug, verdicts };
}
