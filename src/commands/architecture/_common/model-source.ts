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

// Whether a project's intended architecture lives in SonarQube or in a file of its repository.

import { readdir } from 'node:fs/promises';

import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolveCurrentGitBranch } from '@/core/host/git/branch.ts';
import { discoverProject } from '@/core/project-discovery/project-info.ts';
import { ComponentsClient } from '@/core/server/components.ts';

export const MODEL_LOCATION_KEY = 'sonar.architecture.model.location';
const ARCHITECTURE_FILE_NAMES = new Set([
  'sonar-architecture.json',
  'sonar-architecture.yml',
  'sonar-architecture.yaml',
]);
const MODEL_LOCATIONS = ['DYNAMIC', 'FILE', 'SERVER'] as const;

export type ModelLocation = (typeof MODEL_LOCATIONS)[number];

export interface ProjectCheckout {
  /** Architecture files in the base dir of the checkout. */
  files: string[];
  branch?: string;
}

export interface IntendedSource {
  type: 'FILE' | 'SERVER';
  setting: ModelLocation;
  file?: string;
  branch?: string;
  /** False when the command does not run in a checkout of the project, so a file there can't be seen. */
  hasCheckout: boolean;
}

/** The rule the web UI and the analyzer apply, with the checkout standing in for the analysed graph. */
export function decideSource(
  setting: ModelLocation,
  checkout: ProjectCheckout | undefined,
): IntendedSource {
  const hasCheckout = checkout !== undefined;
  const file = checkout?.files.at(0);
  const isFile = setting === 'FILE' || (setting === 'DYNAMIC' && file !== undefined);
  if (!isFile) return { type: 'SERVER', setting, hasCheckout };
  return {
    type: 'FILE',
    setting,
    hasCheckout,
    ...(file === undefined ? {} : { file }),
    ...(checkout?.branch === undefined ? {} : { branch: checkout.branch }),
  };
}

export function parseModelLocation(value: string | undefined): ModelLocation {
  const upper = value?.trim().toUpperCase();
  return MODEL_LOCATIONS.find((location) => location === upper) ?? 'DYNAMIC';
}

export async function resolveIntendedSource(
  ctx: CommandAuthenticatedInvocationContext,
  projectKey: string,
): Promise<IntendedSource> {
  const [setting, checkout] = await Promise.all([
    readModelLocation(ctx, projectKey),
    findCheckout(ctx, projectKey),
  ]);
  return decideSource(setting, checkout);
}

async function readModelLocation(
  ctx: CommandAuthenticatedInvocationContext,
  projectKey: string,
): Promise<ModelLocation> {
  // An unreadable setting falls back to DYNAMIC, the backend default, as in the web UI
  const settings = await new ComponentsClient(ctx.connection.httpClient)
    .getProjectSettings(projectKey)
    .unwrapOr([]);
  return parseModelLocation(settings.find(({ key }) => key === MODEL_LOCATION_KEY)?.value);
}

async function findCheckout(
  ctx: CommandAuthenticatedInvocationContext,
  projectKey: string,
): Promise<ProjectCheckout | undefined> {
  const discovered = await discoverProject(process.cwd(), {
    auth: ctx.auth,
    silent: true,
    console: ctx.console,
  });
  if (discovered.projectKey !== projectKey) return undefined;
  const entries = await readdir(discovered.projectRoot).catch((): string[] => []);
  const files = entries.filter((name) => ARCHITECTURE_FILE_NAMES.has(name.toLowerCase())).sort();
  const branch = await resolveCurrentGitBranch(discovered.projectRoot);
  return { files, ...(branch === undefined ? {} : { branch }) };
}

/** The source as reads print it; `hasCheckout` is a detail of how it was decided. */
export function toSourcePayload({
  hasCheckout: _hasCheckout,
  ...source
}: IntendedSource): Omit<IntendedSource, 'hasCheckout'> {
  return source;
}

/** Where to make the change instead, for a refusal or a read. */
export function describeFileSource(source: IntendedSource): string {
  if (source.file !== undefined) return `${source.file} in its repository`;
  return 'a file in its repository (the Architecture model location is FILE)';
}
