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

export const UNIX_SONAR_COMMAND_GUARD = `if ! command -v sonar &> /dev/null; then
  exit 0
fi`;

export const WINDOWS_SONAR_COMMAND_GUARD = `if (-not (Get-Command sonar -ErrorAction SilentlyContinue)) {
    exit 0
}`;

function unixTemplate(command: string): string {
  return `#!/bin/bash\n${UNIX_SONAR_COMMAND_GUARD}\n${command}\n`;
}

function windowsTemplate(command: string): string {
  return `${WINDOWS_SONAR_COMMAND_GUARD}\n$stdinData = [Console]::In.ReadToEnd()\n$stdinData | & ${command}\n`;
}

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
  return unixTemplate(`sonar hook claude-post-tool-use --project ${projectKey}`);
}

export function getSqaaPostToolTemplateWindows(projectKey: string): string {
  return windowsTemplate(`sonar hook claude-post-tool-use --project ${projectKey}`);
}
