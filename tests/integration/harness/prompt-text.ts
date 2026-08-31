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

// Prompt fragments for `InteractiveSession.waitText()`. Unique prefixes only —
// benefit-text suffixes can change without breaking the wait. Pin the live
// clack form (`?  `) so a submitted `✓  ` line is not treated as the next prompt.

export const KEY = {
  down: '\x1b[B',
  space: ' ',
} as const;

export const PROMPT = {
  tool: '?  Select the tool you want to integrate with',
  scope: '?  Where should SonarQube be integrated?',
  secretsHooks: '?  Install secret scanning hooks?',
  mcp: '?  Install MCP server?',
  vortex: '?  Install Vortex?',
  copilotHook: '?  Install pre-tool-use hook?',
  promptSecretsInstructions: '?  Install prompt-secrets instructions?',
  copilotLocalCopy:
    '?  Global Copilot instructions already exist. Do you also want to create a project-local copy for this repo?',
  secretsOnRead: '?  Install secrets-on-read instructions?',
  codexLocalCopy:
    '?  Global Codex instructions already exist. Do you also want to create a project-local copy for this repo?',
  promptSecretsWorkspace: '?  Install prompt-secrets workspace rules?',
  promptSecretsGlobal: '?  Install prompt-secrets global rules?',
  gitPreCommit: '?  Install pre-commit code scanning hook?',
  gitPrePush: '?  Install pre-push code scanning hook?',
  gitDepRisks: '?  Enable dependency-risks scanning on the pre-commit hook?',
  gitGlobalProceed: '?  Proceed with global installation?',
  keepMcp: '?  MCP server (currently installed)  Keep?',
  keepSecretsHooks: '?  secret scanning hooks (currently installed)  Keep?',
  proceedRemoval: '?  Proceed with removal?',
  connectWhere: '?  Where would you like to connect?',
  cloudRegion: '?  Which SonarQube Cloud region?',
  selectOrg: '?  Select an organization',
  enterOrg: '?  Enter organization key',
  enterServerUrl: '?  Enter server URL',
  connectTo: '?  Connect to:',
  importHow: '?  How do you want to import repositories?',
  selectRepos: '?  Select repositories to import',
  importRegex: '?  Import repositories whose name matches',
  whichIssues: '?  Which issues should the agent fix?',
} as const;
