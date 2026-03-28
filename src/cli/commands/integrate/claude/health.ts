/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Health check orchestrator for Claude Code integration

import { logAndValidate, runSonarQubeConnectivityChecks } from '../_common/integrate-health-core';
import { areHooksInstalled } from './hooks';

export interface HealthCheckResult {
  tokenValid: boolean;
  serverAvailable: boolean;
  projectAccessible: boolean;
  organizationAccessible: boolean;
  qualityProfilesAccessible: boolean;
  hooksInstalled: boolean;
  errors: string[];
}

/**
 * Run health checks for Claude Code (SonarQube API + Claude hook layout under hooksRoot).
 */
export async function runHealthChecks(
  serverURL: string,
  token: string,
  projectKey: string | undefined,
  hooksRoot: string,
  organization?: string,
  verbose = true,
): Promise<HealthCheckResult> {
  const errors: string[] = [];

  const connectivity = await runSonarQubeConnectivityChecks(
    serverURL,
    token,
    projectKey,
    organization,
    verbose,
    errors,
  );

  const hooksInstalled = await logAndValidate(
    'Checking hooks installation...',
    () => areHooksInstalled(hooksRoot),
    'Hooks not installed',
    errors,
    verbose,
  );

  return {
    ...connectivity,
    hooksInstalled,
    errors,
  };
}
