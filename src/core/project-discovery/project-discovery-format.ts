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

// Tiny leaf helpers shared by every project-discovery source, kept dependency-free of project-info.ts to avoid a circular import.

import { isValidServerUrl } from '@/core/auth/auth-resolver.ts';

export function selectValidServerUrl(
  currentServerUrl: string | undefined,
  candidate: string,
): string | undefined {
  return currentServerUrl ?? (isValidServerUrl(candidate) ? candidate : undefined);
}

/**
 * C0, DEL, and C1. ESC and the C1 CSI character start terminal sequences, so a directory name
 * could rewrite the hostname in the trust prompt. Reject the path instead of printing it.
 */
const TERMINAL_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

/** A path the CLI opened. Undefined when the path is not safe to echo into a prompt. */
export function displayConfigPath(configFile: string): string | undefined {
  return TERMINAL_CONTROL.test(configFile) ? undefined : configFile;
}

export function formatFoundConfig(
  label: string,
  configFile: string | undefined,
  fields: string,
): string {
  const path = configFile ? displayConfigPath(configFile) : undefined;
  return path ? `Found ${label} (${path}): ${fields}` : `Found ${label}: ${fields}`;
}

export function formatConfigFields(
  serverUrl?: string,
  projectKey?: string,
  organization?: string,
): string {
  return Object.entries({ project: projectKey, server: serverUrl, org: organization })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}
