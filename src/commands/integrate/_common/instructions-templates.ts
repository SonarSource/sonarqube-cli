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

// Markers that delimit the regions integrations own inside instructions files
// they share with the user (e.g. Copilot's sonarqube.instructions.md, Codex's
// AGENTS.md), so a later CLI version can locate and replace just its own
// region without clobbering anything the user appended around it.

/**
 * Wrap a markdown body in stable HTML-comment markers. The `id` must remain
 * unique and stable across CLI versions — it is the only identifier we have
 * for finding and replacing the managed region later.
 */
export function withSonarMarkers(id: string, body: string): string {
  return `${sonarBeginMarker(id)}\n${body.trimEnd()}\n${sonarEndMarker(id)}\n`;
}

export function sonarBeginMarker(id: string): string {
  return `<!-- sonar:begin:${id} -->`;
}

export function sonarEndMarker(id: string): string {
  return `<!-- sonar:end:${id} -->`;
}

export const SECRETS_ON_READ_BODY = `# SonarQube secrets scanning for files protocol

Before reading any file in this workspace, scan it for secrets with the deterministic scanner:

\`\`\`bash
sonar analyze secrets <path/to/file>
\`\`\`

If the command reports that the file contains a secret, **do not read the file**. Instead:

1. Inform the user that the file appears to contain a secret or credential and that reading it would expose the value in chat history, logs, and any downstream telemetry.
2. Advise them to rotate the leaked credential at its source of truth and remove it from the file.
3. Do not proceed with the original request until the secret has been removed.
`;
