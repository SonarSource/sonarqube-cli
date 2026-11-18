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
import type { MonorepoRootResult } from '../init-outcome.ts';
import { remoteRepositorySlug } from '../remote-host.ts';
import { authorizeOrganization } from './bind.ts';
import type { DetectDeps } from './detect.ts';
import { describeFailure, isRunFatal } from './linked-projects.ts';
import { writeMapping } from './mapping.ts';

/** A root whose project does not exist yet, with the project to create for it. */
export interface BindableRoot {
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
  // `--create` is the consent to create without binding, so it never asks.
  if (
    !remote ||
    intent?.kind === 'create' ||
    (!interactive && intent?.kind !== 'bind') ||
    auth.connectionType !== 'cloud'
  ) {
    return null;
  }
  return remoteRepositorySlug(remote);
}

function allFailed(roots: readonly BindableRoot[], reason: string): MonorepoRootResult[] {
  return roots.map(({ path }) => ({ path, kind: 'failed', reason }));
}

/**
 * Provisions every root through one batched import. A repository takes its monorepo binding once,
 * so this never runs per root. Resolves to each root's result, or to undefined when the roots
 * should be created without binding instead: the user declined, or the repository cannot be bound.
 */
export async function bindNewRoots(
  roots: readonly BindableRoot[],
  remote: string | undefined,
  deps: DetectDeps,
): Promise<MonorepoRootResult[] | undefined> {
  if (roots.length === 0) {
    return undefined;
  }
  // `--bind` is the consent to bind, so what it cannot do is reported, never replaced by an unbound project.
  const required = deps.intent?.kind === 'bind';
  const slug = bindableSlug(remote, deps);
  if (slug === null) {
    return required
      ? allFailed(
          roots,
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
    return roots.map(({ path, projectKey }) => ({ path, kind: 'would-bind', projectKey }));
  }
  // One authorization serves every root: the batch below reuses the key it returns.
  const almKey = linkedAlmKey ?? (await authorizeOrganization(api, auth, org.key, deps));
  if (!almKey) {
    return required
      ? allFailed(roots, 'The organization authorization was declined. Nothing was created.')
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
    return allFailed(roots, describeFailure(error));
  }
  const { selection } = plan;
  if (selection.kind !== 'batch' || selection.repos.length !== 1) {
    const reason = selection.kind === 'batch' ? selection.skipped[0]?.reason : undefined;
    const detail = reason ? `: ${reason}` : '.';
    return allFailed(roots, `Repository '${slug}' cannot be bound${detail} Nothing was created.`);
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
    results.push(await mapCreatedRoot(root, slug, verdicts.get(root.projectKey), deps));
    return results;
  }, Promise.resolve([]));
}

async function mapCreatedRoot(
  { path, projectRoot, projectKey }: BindableRoot,
  slug: string,
  verdict: { done: boolean; detail?: string } | undefined,
  { auth, console }: DetectDeps,
): Promise<MonorepoRootResult> {
  if (!verdict?.done) {
    return {
      path,
      kind: 'failed',
      reason: verdict?.detail ?? `The import did not report project '${projectKey}'.`,
    };
  }
  try {
    await writeMapping(auth, projectKey, projectRoot, console, 'created', true);
    console.success(`Created project '${projectKey}' bound to '${slug}' for ${path}.`);
    return { path, kind: 'bound', projectKey };
  } catch (error) {
    if (isRunFatal(error)) {
      throw error;
    }
    return { path, kind: 'failed', reason: describeFailure(error) };
  }
}
