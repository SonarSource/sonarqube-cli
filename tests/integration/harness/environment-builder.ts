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

// Declarative builder for the isolated test environment: state.json + binary setup

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { buildLocalBinaryName } from '../../../src/cli/commands/_common/install/secrets';
import { SONAR_SECRETS_DIST_PREFIX } from '../../../src/lib/config-constants.js';
import { SECRETS_BINARY_NAME } from '../../../src/lib/install-types.js';
import { generateKeychainAccount } from '../../../src/lib/keychain';
import { detectPlatform } from '../../../src/lib/platform-detector.js';
import { SONAR_SECRETS_VERSION } from '../../../src/lib/signatures.js';
import { buildDownloadUrl } from '../../../src/lib/sonarsource-releases.js';
import type { CliState } from '../../../src/lib/state.js';
import { getDefaultState } from '../../../src/lib/state.js';

function resolveSecretsBinarySource(): string {
  const platform = detectPlatform();
  const downloadUrl = buildDownloadUrl(
    SECRETS_BINARY_NAME,
    SONAR_SECRETS_VERSION,
    SONAR_SECRETS_DIST_PREFIX,
    platform,
  );
  const filename = downloadUrl.split('/').at(-1)!;
  return join(import.meta.dir, '..', 'resources', filename);
}

interface SqaaExtensionConfig {
  projectRoot: string;
  projectKey: string;
  orgKey?: string;
  serverUrl?: string;
}

export class EnvironmentBuilder {
  private activeConnectionUrl?: string;
  private activeConnectionType: 'cloud' | 'on-premise' = 'on-premise';
  private activeConnectionOrgKey?: string;
  private activeConnectionTokenName?: string;
  private _installSecretsBinary = false;
  private _rawStateJson?: string;
  private readonly keychainTokens: Array<{ serverURL: string; token: string; org?: string }> = [];
  private readonly sqaaExtensions: SqaaExtensionConfig[] = [];

  withActiveConnection(
    url: string,
    type: 'cloud' | 'on-premise' = 'on-premise',
    orgKey?: string,
  ): this {
    this.activeConnectionUrl = url;
    this.activeConnectionType = type;
    this.activeConnectionOrgKey = orgKey;
    return this;
  }

  /**
   * Sets the server-generated token name on the active connection. Reflects
   * the value populated by the browser-based OAuth flow (see `AuthConnection.tokenName`).
   * Must be called after `withActiveConnection(...)`.
   */
  withTokenName(tokenName: string): this {
    this.activeConnectionTokenName = tokenName;
    return this;
  }

  /**
   * Convenience: sets up both an active connection and a keychain token in one call.
   * Infers the connection type: 'cloud' when org is provided, 'on-premise' otherwise.
   */
  withAuth(serverUrl: string, token: string, org?: string): this {
    return this.withActiveConnection(
      serverUrl,
      org ? 'cloud' : 'on-premise',
      org,
    ).withKeychainToken(serverUrl, token, org);
  }

  /**
   * Resets the active connection and any seeded keychain tokens. Use to undo
   * a previously-configured `withAuth(...)` (e.g. when the outer `beforeEach`
   * authenticates by default and a single test wants to exercise the
   * unauthenticated path).
   */
  clearAuth(): this {
    this.activeConnectionUrl = undefined;
    this.activeConnectionType = 'on-premise';
    this.activeConnectionOrgKey = undefined;
    this.activeConnectionTokenName = undefined;
    this.keychainTokens.length = 0;
    return this;
  }

  /**
   * Ensures sonar-secrets is available inside the isolated test environment.
   * Copies the mock binary from tests/integration/resources/sonar-secrets
   * into <tempDir>/bin/sonar-secrets.
   */
  withSecretsBinaryInstalled(): this {
    this._installSecretsBinary = true;
    return this;
  }

  /**
   * Stores a token in the file-based keychain when writeTo() is called.
   */
  withKeychainToken(serverURL: string, token: string, org?: string): this {
    this.keychainTokens.push({ serverURL, token, org });
    return this;
  }

  /**
   * Write a raw JSON string as state.json instead of building state from the builder fields.
   * Use this to simulate state files written by older CLI versions.
   */
  withRawState(json: string): this {
    this._rawStateJson = json;
    return this;
  }

  /**
   * Registers a sonar-sqaa PostToolUse extension for a project.
   * Required for `analyze sqaa` and `analyze` (full pipeline) to run SQAA.
   */
  withSqaaExtension(
    projectRoot: string,
    projectKey: string,
    orgKey?: string,
    serverUrl?: string,
  ): this {
    this.sqaaExtensions.push({ projectRoot, projectKey, orgKey, serverUrl });
    return this;
  }

  build(): CliState {
    const state = getDefaultState('integration-test');

    // disable telemetry for integration tests
    state.telemetry.enabled = false;

    if (this.activeConnectionUrl) {
      const connectionId = 'test-connection-id';
      state.auth.isAuthenticated = true;
      state.auth.connections = [
        {
          id: connectionId,
          type: this.activeConnectionType,
          serverUrl: this.activeConnectionUrl,
          orgKey: this.activeConnectionOrgKey,
          tokenName: this.activeConnectionTokenName,
          authenticatedAt: new Date().toISOString(),
        },
      ];
      state.auth.activeConnectionId = connectionId;
    }

    if (this._installSecretsBinary) {
      state.tools = {
        installed: [
          {
            name: 'sonar-secrets',
            version: SONAR_SECRETS_VERSION,
            path: buildLocalBinaryName(detectPlatform()),
            installedAt: new Date().toISOString(),
            installedByCliVersion: 'integration-test',
          },
        ],
      };
    }

    for (const ext of this.sqaaExtensions) {
      // Resolve symlinks so the stored path matches process.cwd() in the CLI subprocess
      // (e.g. /var/folders/... → /private/var/folders/... on macOS)
      let resolvedRoot: string;
      try {
        resolvedRoot = realpathSync(ext.projectRoot);
      } catch {
        resolvedRoot = ext.projectRoot;
      }
      state.agentExtensions.push({
        id: randomUUID(),
        agentId: 'claude-code',
        projectRoot: resolvedRoot,
        global: false,
        projectKey: ext.projectKey,
        orgKey: ext.orgKey ?? this.activeConnectionOrgKey,
        serverUrl: ext.serverUrl ?? this.activeConnectionUrl,
        updatedByCliVersion: 'integration-test',
        updatedAt: new Date().toISOString(),
        kind: 'hook',
        name: 'sonar-sqaa',
        hookType: 'PostToolUse',
      });
    }

    return state;
  }

  /**
   * Writes state.json and the keychain JSON file, and if withSecretsBinaryInstalled() was called, copies the mock binary.
   */
  writeTo(cliHome: string, keychainFile: string): void {
    mkdirSync(cliHome, { recursive: true });
    const stateJson = this._rawStateJson ?? JSON.stringify(this.build(), null, 2);
    writeFileSync(join(cliHome, 'state.json'), stateJson, 'utf-8');

    if (this.keychainTokens.length > 0) {
      const tokens: Record<string, string> = {};
      for (const { serverURL, token, org } of this.keychainTokens) {
        const account = generateKeychainAccount(serverURL, org);
        tokens[account] = token;
      }
      writeFileSync(keychainFile, JSON.stringify({ tokens }, null, 2), 'utf-8');
    }

    if (this._installSecretsBinary) {
      const binDir = join(cliHome, 'bin');
      mkdirSync(binDir, { recursive: true });

      const source = resolveSecretsBinarySource();
      const versionedName = buildLocalBinaryName(detectPlatform());
      const destPath = join(binDir, versionedName);
      if (!existsSync(destPath)) {
        if (!existsSync(source)) {
          throw new Error(
            `sonar-secrets binary not found at: ${source}\n` +
              `Run 'bun run test:integration:prepare' to download it.`,
          );
        }
        copyFileSync(source, destPath);
        chmodSync(destPath, 0o755);
      }
    }
  }
}
