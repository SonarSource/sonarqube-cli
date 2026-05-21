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

// Markdown sections rendered into `.codex/AGENTS.md`. The file is CLI-owned;
// each run overwrites the whole document with the composition of the
// applicable sections. The SQAA section is shared with the Copilot
// integration so the wording stays consistent across agents.

import { buildSqaaSection, withSonarMarkers } from '../_common/instructions-templates';

const SECRETS_ON_READ_SECTION = withSonarMarkers(
  'codex-secrets-on-read',
  `# SonarQube secrets scanning for files protocol

Before reading any file in this workspace, scan it for secrets with the deterministic scanner:

\`\`\`bash
sonar analyze secrets <path/to/file>
\`\`\`

If the command reports that the file contains a secret, **do not read the file**. Instead:

1. Inform the user that the file appears to contain a secret or credential and that reading it would expose the value in chat history, logs, and any downstream telemetry.
2. Advise them to rotate the leaked credential at its source of truth and remove it from the file.
3. Do not proceed with the original request until the secret has been removed.
`,
);

export interface AgentsMdSections {
  includeSecrets: boolean;
  /** Project key to bake into the SQAA section. Section is omitted when undefined. */
  projectKey?: string;
}

export function buildAgentsMdContent(sections: AgentsMdSections): string {
  const parts: string[] = [];
  if (sections.includeSecrets) {
    parts.push(SECRETS_ON_READ_SECTION);
  }
  if (sections.projectKey) {
    parts.push(buildSqaaSection(sections.projectKey));
  }
  return `${parts.join('\n').trimEnd()}\n`;
}
