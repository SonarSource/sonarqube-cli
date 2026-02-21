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

/** Root directory for all CLI data: ~/.sonarqube-cli */
export const CLI_DIR = join(homedir(), `.${APP_NAME}`);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const STATE_FILE = join(CLI_DIR, 'state.json');

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export const LOG_DIR = join(CLI_DIR, 'logs');
export const LOG_FILE = join(LOG_DIR, '${APP_NAME}.log');

// ---------------------------------------------------------------------------
// sonar-secrets binary
// ---------------------------------------------------------------------------

export const BIN_DIR = join(CLI_DIR, 'bin');

// ---------------------------------------------------------------------------
// SonarCloud
// ---------------------------------------------------------------------------

export const SONARCLOUD_HOSTNAME = 'sonarcloud.io';
export const SONARCLOUD_URL = `https://sonarcloud.io`;
export const SONARCLOUD_API_URL = 'https://api.sonarcloud.io';

// ---------------------------------------------------------------------------
// Auth loopback server
//
// Port range used by the SonarLint protocol. SonarQube/SonarCloud validates
// that the callback port falls within this range before POSTing the token.
// Must match the range defined in SonarLint Core (EmbeddedServer.java: 64120-64130).
// ---------------------------------------------------------------------------

export const AUTH_PORT_START = 64120;
export const AUTH_PORT_COUNT = 11;
