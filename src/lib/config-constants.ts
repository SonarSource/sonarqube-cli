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

/**
 * Central configuration constants for the SonarQube CLI.
 *
 * Path defaults are computed once at module load time. `SONAR_USER_HOME` is
 * only intended as a late-bound override for codepaths that explicitly call
 * the getter functions (currently state persistence and telemetry user-id
 * resolution); other exported path constants remain fixed after import.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// App name
// ---------------------------------------------------------------------------

export const APP_NAME = 'sonarqube-cli';

/** The CLI command name as it appears on PATH after installation. */
export const CLI_COMMAND = process.platform === 'win32' ? 'sonar.exe' : 'sonar';

// ---------------------------------------------------------------------------
// CLI data directory
// ---------------------------------------------------------------------------

export const ENV_SONAR_USER_HOME = 'SONAR_USER_HOME';

/** Shared root directory for Sonar product data: ~/.sonar */
export function getSonarUserHome(): string {
  return process.env[ENV_SONAR_USER_HOME] ?? join(homedir(), '.sonar');
}

/** Root directory for all CLI data: ~/.sonar/sonarqube-cli */
export function getCliDir(): string {
  return join(getSonarUserHome(), 'sonarqube-cli');
}

export const SONAR_USER_HOME = getSonarUserHome();
export const CLI_DIR = getCliDir();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const STATE_FILE = join(CLI_DIR, 'state.json');

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export const LOG_DIR = join(CLI_DIR, 'logs');
export const LOG_FILE = join(LOG_DIR, `${APP_NAME}.log`);

/** SCA scanner download cache used by dependency-risk analysis. */
export const SCA_SCANNER_CACHE_DIR = join(CLI_DIR, 'sca-scanner-cache');

// ---------------------------------------------------------------------------
// sonar-secrets binary
// ---------------------------------------------------------------------------

export const BIN_DIR = join(CLI_DIR, 'bin');

/** Directory used for global git hooks when core.hooksPath is set via sonar integrate git --global. */
export const GLOBAL_HOOKS_DIR = join(CLI_DIR, 'hooks');

// ---------------------------------------------------------------------------
// Antigravity
// ---------------------------------------------------------------------------

/** Antigravity workspace agents directory (relative to the project root). Shared with Codex CAG skills under `.agents/skills/`. */
export const ANTIGRAVITY_PROJECT_AGENTS_DIR = '.agents';

/** Project Antigravity hooks config (relative to the project root). */
export const ANTIGRAVITY_PROJECT_HOOKS_JSON = join(ANTIGRAVITY_PROJECT_AGENTS_DIR, 'hooks.json');

/** Project Sonar hook scripts directory (relative to the project root). */
export const ANTIGRAVITY_PROJECT_SONAR_HOOKS_DIR = join(
  ANTIGRAVITY_PROJECT_AGENTS_DIR,
  'sonar',
  'hooks',
);

/** Sonar hook scripts directory relative to `.agents/` (Antigravity PreToolUse cwd). */
export const ANTIGRAVITY_PROJECT_SONAR_HOOKS_DIR_FROM_AGENTS = join('sonar', 'hooks');

/**
 * Global Antigravity config root (`sonar integrate antigravity --global`).
 * Hook scripts and config patches live under this tree (not a plugin bundle).
 */
export const ANTIGRAVITY_GLOBAL_CONFIG_DIR = join(homedir(), '.gemini', 'config');

/** Global Antigravity hooks config (`sonar integrate antigravity --global`). */
export const ANTIGRAVITY_GLOBAL_HOOKS_JSON = join(ANTIGRAVITY_GLOBAL_CONFIG_DIR, 'hooks.json');

/** Global Antigravity MCP config (Antigravity only supports a single user-level file). */
export const ANTIGRAVITY_GLOBAL_MCP_CONFIG_JSON = join(
  ANTIGRAVITY_GLOBAL_CONFIG_DIR,
  'mcp_config.json',
);

/** Global Sonar hook scripts directory (`sonar integrate antigravity --global`). */
export const ANTIGRAVITY_GLOBAL_SONAR_HOOKS_DIR = join(
  ANTIGRAVITY_GLOBAL_CONFIG_DIR,
  'sonar',
  'hooks',
);

/** Global Antigravity skills directory (`sonar integrate antigravity --global` CAG skill). */
export const ANTIGRAVITY_GLOBAL_SKILLS_DIR = join(ANTIGRAVITY_GLOBAL_CONFIG_DIR, 'skills');

/** Antigravity global rules file (`sonar integrate antigravity --global`). */
export const ANTIGRAVITY_GLOBAL_GEMINI_MD = join(homedir(), '.gemini', 'GEMINI.md');

/** Project Antigravity rules directory (relative to the project root). */
export const ANTIGRAVITY_PROJECT_RULES_DIR = join(ANTIGRAVITY_PROJECT_AGENTS_DIR, 'rules');

/** Workspace rule: prompt-secrets protocol (`.agents/rules/sonar-prompt-secrets.md`). */
export const ANTIGRAVITY_PROMPT_SECRETS_RULE_FILE = 'sonar-prompt-secrets.md';

/** Workspace rule: SQAA protocol (`.agents/rules/sonar-agentic-analysis.md`). */
export const ANTIGRAVITY_SQAA_RULE_FILE = 'sonar-agentic-analysis.md';

/** Legacy instructions paths (pre-Rules); removed on re-integrate when Sonar-managed. */
export const ANTIGRAVITY_LEGACY_PROJECT_INSTRUCTIONS_PATH = join(
  ANTIGRAVITY_PROJECT_AGENTS_DIR,
  'instructions',
  'sonarqube.instructions.md',
);

export const ANTIGRAVITY_LEGACY_GLOBAL_INSTRUCTIONS_PATH = join(
  ANTIGRAVITY_GLOBAL_CONFIG_DIR,
  'instructions',
  'sonarqube.instructions.md',
);

// ---------------------------------------------------------------------------
// Sonarsource binaries
// ---------------------------------------------------------------------------

/** Base URL for downloading SonarSource binaries. Override via SONARQUBE_CLI_BINARIES_URL for test environments. */
export const SONARSOURCE_BINARIES_URL =
  process.env.SONARQUBE_CLI_BINARIES_URL ?? 'https://binaries.sonarsource.com';
export const SONAR_SECRETS_DIST_PREFIX = 'CommercialDistribution/sonar-secrets';
export const SCA_SCANNER_CLI_DIST_PREFIX = 'CommercialDistribution/sca-scanner-cli';
/**
 * Path prefix on binaries.sonarsource.com for sonar-context-augmentation. The full
 * path embeds the platform: `${SONAR_CONTEXT_AUGMENTATION_DIST_PREFIX}-${platform}/...`.
 */
export const SONAR_CONTEXT_AUGMENTATION_DIST_PREFIX = 'Distribution/sonar-context-augmentation';
export const CLI_STABLE_VERSION_PATH = 'Distribution/sonarqube-cli/stable.version';
export const UPDATE_SCRIPT_BASE_URL =
  'https://raw.githubusercontent.com/SonarSource/sonarqube-cli/refs/heads/master/user-scripts';

// ---------------------------------------------------------------------------
// SonarCloud
// ---------------------------------------------------------------------------

export const SONARCLOUD_URL = process.env.SONARQUBE_CLI_SONARCLOUD_URL ?? 'https://sonarcloud.io';
export const SONARCLOUD_US_URL =
  process.env.SONARQUBE_CLI_SONARCLOUD_US_URL ?? 'https://sonarqube.us';
export const SONARCLOUD_HOSTNAME = new URL(SONARCLOUD_URL).hostname;
export const SONARCLOUD_US_HOSTNAME = new URL(SONARCLOUD_US_URL).hostname;
export const SONARCLOUD_API_URL =
  process.env.SONARQUBE_CLI_SONARCLOUD_API_URL ?? 'https://api.sonarcloud.io';
export const SONARCLOUD_US_API_URL =
  process.env.SONARQUBE_CLI_SONARCLOUD_US_API_URL ?? 'https://api.sonarqube.us';
export const SONARCLOUD_SCA_SCANNER_CDN_URL =
  process.env.SONARQUBE_CLI_SONARCLOUD_SCA_SCANNER_CDN_URL ??
  'https://scanner.sonarcloud.io/tidelift-cli';

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------

export const DOCS_URL = 'https://docs.sonarsource.com/sonarqube-cli';
export const CLOUD_API_DOCS_URL = 'https://docs.sonarsource.com/sonarqube-cloud/appendices/web-api';
export const AI_REMEDIATION_DOCS_URL =
  'https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/ai-features/sonarqube-remediation-agent';
export const SERVER_API_DOCS_URL =
  'https://docs.sonarsource.com/sonarqube-server/extension-guide/web-api';
export const SUPPORT_URL = 'https://community.sonarsource.com';
export const AGENTIC_ANALYSIS_DOCS_URL =
  'https://docs.sonarsource.com/agent-centric-development-cycle/features/agentic-analysis';

// ---------------------------------------------------------------------------
// Application paths
// ---------------------------------------------------------------------------

export const AGENT_ACTIVITY_PATH = '/project/agent_activity';

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export const CURSOR_CONFIG_DIR = '.cursor';
export const CURSOR_IGNORE_FILE = '.cursorignore';

// ---------------------------------------------------------------------------
// Context Augmentation
// ---------------------------------------------------------------------------

export const SONAR_CONTEXT_INVOCATION = 'sonar context';

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

/** Default Docker image for `sonar run mcp`. */
export const SONARQUBE_MCP_DOCKER_IMAGE_NAME = 'sonarsource/sonarqube-mcp';

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/** Env var that disables telemetry when set to 1. */
export const ENV_DO_NOT_TRACK = 'DO_NOT_TRACK';

/** Directory for telemetry artefacts that are not part of state.json. */
export function getTelemetryDir(): string {
  return join(getCliDir(), 'telemetry');
}

/** Telemetry ingest endpoint shared by all event types. */
export const TELEMETRY_ENDPOINT = 'https://events.sonardata.io/cli';

/** Write-only ingest API key — intentionally embedded in the binary. */
export const TELEMETRY_API_KEY = 'hJPRohLsOsasZeOhSCSNDiL4h2yR96S5fOWJqRch';

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------

/** DSN for Sentry error reporting. */
export const SENTRY_DSN =
  'https://cff421c13bc1b079963fd6dfa5bf80e5@o1316750.ingest.us.sentry.io/4511110855000064';

/** Max time to wait for Sentry to flush queued events on shutdown. */
export const SENTRY_FLUSH_TIMEOUT_MS = 500;

// ---------------------------------------------------------------------------
// Auth loopback server
//
// Port range used by the SonarLint protocol. SonarQube/SonarCloud validates
// that the callback port falls within this range before POSTing the token.
// Must match the range defined in SonarLint Core (EmbeddedServer.java: 64120-64130).
// ---------------------------------------------------------------------------

export const AUTH_PORT_START = 64120;
export const AUTH_PORT_COUNT = 11;

// ---------------------------------------------------------------------------
// Test / integration overrides
// ---------------------------------------------------------------------------

/** Env var to shorten SQAA 503 retry backoff (ms). Used by the integration harness only. */
export const ENV_SQAA_RETRY_BASE_DELAY_MS = 'SONARQUBE_CLI_SQAA_RETRY_BASE_DELAY_MS';

const DEFAULT_SQAA_RETRY_503_BASE_DELAY_MS = 2000;

/**
 * Base delay for SQAA 503 retry backoff. Attempt N waits base * 2^(N-1) (2s, 4s, 8s by default).
 * Override via {@link ENV_SQAA_RETRY_BASE_DELAY_MS} in integration tests.
 */
export function getSqaaRetry503BaseDelayMs(): number {
  const raw = process.env[ENV_SQAA_RETRY_BASE_DELAY_MS];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_SQAA_RETRY_503_BASE_DELAY_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SQAA_RETRY_503_BASE_DELAY_MS;
  }
  return parsed;
}
