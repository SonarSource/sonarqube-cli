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

import type { GitHookType } from '../options';

export const HOOK_MARKER = 'Sonar git hook - installed by sonar integrate git';
// Legacy marker from earlier CLI versions — kept so re-running `sonar integrate git`
// recognises and upgrades hooks installed before the marker was generalised.
export const LEGACY_HOOK_MARKERS = ['Sonar secrets scan - installed by sonar integrate git'];
export const SONAR_HOOK_SKIP_SECRETS_MESSAGE = 'sonarqube-cli not found, skipping sonar hooks';

export function hasSonarHookMarker(content: string): boolean {
  if (content.includes(HOOK_MARKER)) return true;
  return LEGACY_HOOK_MARKERS.some((m) => content.includes(m));
}

export function resolveSonarHookCommand(hook: GitHookType): string {
  return hook === 'pre-commit' ? 'git-pre-commit' : 'git-pre-push';
}
