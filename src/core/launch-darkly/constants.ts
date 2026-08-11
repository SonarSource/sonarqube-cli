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

/**
 * LaunchDarkly client-side ID for Private Beta flag evaluation.
 * Override via {@link ENV_LAUNCHDARKLY_CLIENT_SIDE_ID} (tests / local overrides).
 * When empty, Private Beta commands are treated as not entitled.
 */
export const ENV_LAUNCHDARKLY_CLIENT_SIDE_ID = 'SONARQUBE_CLI_LAUNCHDARKLY_CLIENT_SIDE_ID';

/** Placeholder until the {@link LAUNCHDARKLY_PROJECT_KEY} environment client-side ID is provisioned. */
export const LAUNCHDARKLY_CLIENT_SIDE_ID =
  process.env[ENV_LAUNCHDARKLY_CLIENT_SIDE_ID]?.trim() || '';

/** How long cached Private Beta flag decisions remain valid. */
export const FEATURE_FLAG_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Short timeout so a LaunchDarkly refresh does not stall CLI startup. */
export const LAUNCHDARKLY_INIT_TIMEOUT_SECONDS = 2;
