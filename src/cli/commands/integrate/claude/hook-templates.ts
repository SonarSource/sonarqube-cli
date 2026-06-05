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

// Hook script templates for Claude Code integration

import {
  formatSqaaPostToolHookCommandUnix,
  formatSqaaPostToolHookCommandWindows,
  unixTemplate,
  windowsTemplate,
} from '../_common/hooks';

export function getSecretPreToolTemplateUnix(): string {
  return unixTemplate('sonar hook claude-pre-tool-use');
}

export function getSecretPreToolTemplateWindows(): string {
  return windowsTemplate('sonar hook claude-pre-tool-use');
}

export function getSecretPromptTemplateUnix(): string {
  return unixTemplate('sonar hook claude-prompt-submit');
}

export function getSecretPromptTemplateWindows(): string {
  return windowsTemplate('sonar hook claude-prompt-submit');
}

export function getSqaaPostToolTemplateUnix(projectKey: string): string {
  return unixTemplate(formatSqaaPostToolHookCommandUnix('claude-post-tool-use', projectKey));
}

export function getSqaaPostToolTemplateWindows(projectKey: string): string {
  return windowsTemplate(formatSqaaPostToolHookCommandWindows('claude-post-tool-use', projectKey));
}
