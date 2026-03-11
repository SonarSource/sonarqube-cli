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
export const CLI_DIR = join(homedir(), '.sonar', APP_NAME);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const STATE_FILE = join(CLI_DIR, 'state.json');

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export const LOG_DIR = join(CLI_DIR, 'logs');
export const LOG_FILE = join(LOG_DIR, `${APP_NAME}.log`);

// ---------------------------------------------------------------------------
// sonar-secrets binary
// ---------------------------------------------------------------------------

export const BIN_DIR = join(CLI_DIR, 'bin');

// ---------------------------------------------------------------------------
// Sonarsource binaries
// ---------------------------------------------------------------------------

/** Base URL for downloading SonarSource binaries. Override via SONAR_CLI_BINARIES_URL for test environments. */
export const SONARSOURCE_BINARIES_URL =
  process.env.SONAR_CLI_BINARIES_URL ?? 'https://binaries.sonarsource.com';
export const SONAR_SECRETS_DIST_PREFIX = 'CommercialDistribution/sonar-secrets';
export const UPDATE_SCRIPT_BASE_URL =
  'https://raw.githubusercontent.com/SonarSource/sonarqube-cli/refs/heads/master/user-scripts';

// ---------------------------------------------------------------------------
// SonarCloud
// ---------------------------------------------------------------------------

export const SONARCLOUD_URL = process.env.SONAR_CLI_SONARCLOUD_URL ?? 'https://sonarcloud.io';
export const SONARCLOUD_US_URL = process.env.SONAR_CLI_SONARCLOUD_US_URL ?? 'https://sonarqube.us';
export const SONARCLOUD_HOSTNAME = new URL(SONARCLOUD_URL).hostname;
export const SONARCLOUD_US_HOSTNAME = new URL(SONARCLOUD_US_URL).hostname;
export const SONARCLOUD_API_URL =
  process.env.SONAR_CLI_SONARCLOUD_API_URL ?? 'https://api.sonarcloud.io';
export const SONARCLOUD_US_API_URL =
  process.env.SONAR_CLI_SONARCLOUD_US_API_URL ?? 'https://api.sonarqube.us';

// ---------------------------------------------------------------------------
// Auth loopback server
//
// Port range used by the SonarLint protocol. SonarQube/SonarCloud validates
// that the callback port falls within this range before POSTing the token.
// Must match the range defined in SonarLint Core (EmbeddedServer.java: 64120-64130).
// ---------------------------------------------------------------------------

export const AUTH_PORT_START = 64120;
export const AUTH_PORT_COUNT = 11;
