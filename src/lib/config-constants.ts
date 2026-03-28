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

/**
 * Central configuration constants for the SonarQube CLI.
 *
 * Paths are computed once at module load time.
 * All files that need these values should import from here.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// App name
// ---------------------------------------------------------------------------

export const APP_NAME = 'sonarqube-cli';

// ---------------------------------------------------------------------------
// CLI data directory
// ---------------------------------------------------------------------------

/** Root directory for all CLI data: ~/.sonar/sonarqube-cli */
export const CLI_DIR: string = join(homedir(), '.sonar', APP_NAME);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const STATE_FILE: string = join(CLI_DIR, 'state.json');

// ---------------------------------------------------------------------------
// Anthropic Claude Code
// ---------------------------------------------------------------------------

/** Claude Code user agent directory (~/.claude). */
export const CLAUDE_DIR: string = join(homedir(), '.claude');

/** Claude Code MCP config at ~/.claude.json (global MCP + per-project overrides). */
export const CLAUDE_MCP_CONFIG_FILE: string = join(homedir(), '.claude.json');

/** Agent directory name at project or user scope (e.g. `<root>/.claude/`). */
export const CLAUDE_AGENT_DIR_NAME = '.claude';

/** `hooks` subdirectory under `.claude/`. */
export const CLAUDE_HOOKS_DIR_NAME = 'hooks';

/** `settings.json` inside `.claude/`. */
export const CLAUDE_SETTINGS_FILE = 'settings.json';

/** Sonar secrets hook bundle under `.claude/hooks/`. */
export const CLAUDE_SONAR_SECRETS_HOOKS_DIR_NAME = 'sonar-secrets';

/** Path to `settings.json` for a config layer (`baseDir` is project root or homedir). */
export function claudeSettingsJsonPath(baseDir: string): string {
  return join(baseDir, CLAUDE_AGENT_DIR_NAME, CLAUDE_SETTINGS_FILE);
}

/** Path to `.claude/hooks` for a config layer. */
export function claudeHooksDirPath(baseDir: string): string {
  return join(baseDir, CLAUDE_AGENT_DIR_NAME, CLAUDE_HOOKS_DIR_NAME);
}

/** Path to `.claude/hooks/sonar-secrets` for a config layer. */
export function claudeSonarSecretsHooksPath(baseDir: string): string {
  return join(claudeHooksDirPath(baseDir), CLAUDE_SONAR_SECRETS_HOOKS_DIR_NAME);
}

/** Path to `.claude/hooks/sonar-secrets/build-scripts` for a config layer. */
export function claudeSonarSecretsBuildScriptsPath(baseDir: string): string {
  return join(claudeSonarSecretsHooksPath(baseDir), 'build-scripts');
}

// ---------------------------------------------------------------------------
// OpenAI Codex
// ---------------------------------------------------------------------------

/** OpenAI Codex user config directory (~/.codex). */
export const CODEX_DIR: string = join(homedir(), '.codex');

/** Codex MCP server config (~/.codex/config.toml). */
export const CODEX_USER_CONFIG_FILE: string = join(CODEX_DIR, 'config.toml');

/** Codex agent directory name at project or user scope (e.g. `<root>/.codex/`). */
export const CODEX_AGENT_DIR_NAME = '.codex';

/** Path to `hooks.json` next to a config layer (`baseDir` is project root or homedir). */
export function codexHooksJsonPath(baseDir: string): string {
  return join(baseDir, CODEX_AGENT_DIR_NAME, 'hooks.json');
}

/** Path to `.codex/hooks` for a config layer. */
export function codexHooksDirPath(baseDir: string): string {
  return join(baseDir, CODEX_AGENT_DIR_NAME, 'hooks');
}

/** Path to `.codex/hooks/sonar-secrets` for a config layer. */
export function codexSonarSecretsHooksPath(baseDir: string): string {
  return join(codexHooksDirPath(baseDir), 'sonar-secrets');
}

/** Path to `.codex/hooks/sonar-secrets/build-scripts` for a config layer. */
export function codexSonarSecretsBuildScriptsPath(baseDir: string): string {
  return join(codexSonarSecretsHooksPath(baseDir), 'build-scripts');
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export const LOG_DIR: string = join(CLI_DIR, 'logs');
export const LOG_FILE: string = join(LOG_DIR, `${APP_NAME}.log`);

// ---------------------------------------------------------------------------
// sonar-secrets binary
// ---------------------------------------------------------------------------

export const BIN_DIR: string = join(CLI_DIR, 'bin');

/** Directory used for global git hooks when core.hooksPath is set via sonar integrate git --global. */
export const GLOBAL_HOOKS_DIR: string = join(CLI_DIR, 'hooks');

// ---------------------------------------------------------------------------
// Sonarsource binaries
// ---------------------------------------------------------------------------

/** Base URL for downloading SonarSource binaries. Override via SONARQUBE_CLI_BINARIES_URL for test environments. */
export const SONARSOURCE_BINARIES_URL: string =
  process.env.SONARQUBE_CLI_BINARIES_URL ?? 'https://binaries.sonarsource.com';
export const SONAR_SECRETS_DIST_PREFIX = 'CommercialDistribution/sonar-secrets';
export const UPDATE_SCRIPT_BASE_URL =
  'https://raw.githubusercontent.com/SonarSource/sonarqube-cli/refs/heads/master/user-scripts';

// ---------------------------------------------------------------------------
// SonarCloud
// ---------------------------------------------------------------------------

export const SONARCLOUD_URL: string =
  process.env.SONARQUBE_CLI_SONARCLOUD_URL ?? 'https://sonarcloud.io';
export const SONARCLOUD_US_URL: string =
  process.env.SONARQUBE_CLI_SONARCLOUD_US_URL ?? 'https://sonarqube.us';
export const SONARCLOUD_HOSTNAME: string = new URL(SONARCLOUD_URL).hostname;
export const SONARCLOUD_US_HOSTNAME: string = new URL(SONARCLOUD_US_URL).hostname;
export const SONARCLOUD_API_URL: string =
  process.env.SONARQUBE_CLI_SONARCLOUD_API_URL ?? 'https://api.sonarcloud.io';
export const SONARCLOUD_US_API_URL: string =
  process.env.SONARQUBE_CLI_SONARCLOUD_US_API_URL ?? 'https://api.sonarqube.us';

// ---------------------------------------------------------------------------
// Auth loopback server
//
// Port range used by the SonarLint protocol. SonarQube/SonarCloud validates
// that the callback port falls within this range before POSTing the token.
// Must match the range defined in SonarLint Core (EmbeddedServer.java: 64120-64130).
// ---------------------------------------------------------------------------

export const AUTH_PORT_START = 64120;
export const AUTH_PORT_COUNT = 11;
