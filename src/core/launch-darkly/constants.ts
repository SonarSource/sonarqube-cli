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

import { join } from 'node:path';

import { getCliDir } from '@/core/config-constants.ts';

/** Disk cache for LaunchDarkly Private Beta flag decisions and SDK local storage. */
export function getLaunchDarklyDir(): string {
  return join(getCliDir(), 'launch-darkly');
}

/**
 * LaunchDarkly project key for CLI Private Beta flags.
 * Not used by the SDK at runtime (the client-side ID is); kept here so
 * contributors know where to create/manage flags.
 */
export const LAUNCHDARKLY_PROJECT_KEY = 'sonarqube-cli';

export const LAUNCHDARKLY_ENVIRONMENTS = ['production', 'dev'] as const;
export type LaunchDarklyEnvironment = (typeof LAUNCHDARKLY_ENVIRONMENTS)[number];

/**
 * Selects the LaunchDarkly environment (`production` or `dev`).
 * Unset / unrecognized values default to `production`.
 */
export const ENV_LAUNCHDARKLY_ENVIRONMENT = 'SONARQUBE_CLI_LAUNCHDARKLY_ENV';

/**
 * Client-side IDs per LaunchDarkly environment in project {@link LAUNCHDARKLY_PROJECT_KEY}.
 * These are public client-side IDs (safe to embed); never use a server-side SDK key.
 */
export const LAUNCHDARKLY_CLIENT_SIDE_IDS = {
  production: '6a7b162975fe130aa05cde6b',
  dev: '6a7b1d47b8444e0a8db3b291',
} as const satisfies Record<LaunchDarklyEnvironment, string>;

export function resolveLaunchDarklyEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): LaunchDarklyEnvironment {
  const raw = env[ENV_LAUNCHDARKLY_ENVIRONMENT]?.trim().toLowerCase();
  return raw === 'dev' ? 'dev' : 'production';
}

export function resolveLaunchDarklyClientSideId(env: NodeJS.ProcessEnv = process.env): string {
  return LAUNCHDARKLY_CLIENT_SIDE_IDS[resolveLaunchDarklyEnvironment(env)];
}

/** How long cached Private Beta flag decisions remain valid. */
const FEATURE_FLAG_CACHE_TTL_HOURS = 12;
export const FEATURE_FLAG_CACHE_TTL_MS = FEATURE_FLAG_CACHE_TTL_HOURS * 60 * 60 * 1000;

/** Short timeout so a LaunchDarkly refresh does not stall CLI startup. */
export const LAUNCHDARKLY_INIT_TIMEOUT_SECONDS = 2;
