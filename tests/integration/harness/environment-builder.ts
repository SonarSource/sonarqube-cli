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

// Declarative builder for the isolated test environment: state.json + binary setup

import {
  mkdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CliState } from '../../../src/lib/state.js';
import { getDefaultState } from '../../../src/lib/state.js';
import { detectPlatform } from '../../../src/lib/platform-detector.js';
import { SONAR_SECRETS_VERSION } from '../../../src/lib/signatures.js';
import { buildDownloadUrl } from '../../../src/lib/sonarsource-releases.js';

/** Mirrors the account-key logic in src/lib/keychain.ts */
function toKeychainAccount(serverURL: string, org?: string): string {
  try {
    const hostname = new URL(serverURL).hostname;
    return org ? `${hostname}:${org}` : hostname;
  } catch {
    return serverURL;
  }
}

function resolveSecretsBinarySource(): string {
  const platform = detectPlatform();
  const downloadUrl = buildDownloadUrl(SONAR_SECRETS_VERSION, platform);
  const filename = downloadUrl.split('/').at(-1)!;
  return join(import.meta.dir, '..', 'resources', filename);
}

interface A3sExtensionConfig {
  projectRoot: string;
  projectKey: string;
  orgKey?: string;
  serverUrl?: string;
}

export class EnvironmentBuilder {
  private activeConnectionUrl?: string;
  private activeConnectionType: 'cloud' | 'on-premise' = 'on-premise';
  private activeConnectionOrgKey?: string;
  private _installSecretsBinary = false;
  private readonly keychainTokens: Array<{ serverURL: string; token: string; org?: string }> = [];
  private readonly a3sExtensions: A3sExtensionConfig[] = [];

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
   * Ensures sonar-secrets is available inside the isolated test environment.
   * Copies the mock binary from tests/integration/resources/sonar-secrets
   * into <tempDir>/bin/sonar-secrets.
   */
  withSecretsBinaryInstalled(): this {
    this._installSecretsBinary = true;
    return this;
  }

  /**
   * Stores a token in the file-based keychain used by the isolated test environment.
   * Use this to test flows that read tokens from the keychain (e.g. list projects).
   */
  withKeychainToken(serverURL: string, token: string, org?: string): this {
    this.keychainTokens.push({ serverURL, token, org });
    return this;
  }

  /**
   * Registers a sonar-a3s PostToolUse extension for a project.
   * Required for `analyze a3s` and `analyze` (full pipeline) to run A3S.
   */
  withA3sExtension(
    projectRoot: string,
    projectKey: string,
    orgKey?: string,
    serverUrl?: string,
  ): this {
    this.a3sExtensions.push({ projectRoot, projectKey, orgKey, serverUrl });
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
          authenticatedAt: new Date().toISOString(),
          keystoreKey: `sonarqube-cli:${this.activeConnectionUrl}`,
        },
      ];
      state.auth.activeConnectionId = connectionId;
    }

    if (this._installSecretsBinary) {
      state.tools = {
        installed: [
          {
            name: 'sonar-secrets',
            version: 'integration-test',
            path: resolveSecretsBinarySource(),
            installedAt: new Date().toISOString(),
            installedByCliVersion: 'integration-test',
          },
        ],
      };
    }

    for (const ext of this.a3sExtensions) {
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
        name: 'sonar-a3s',
        hookType: 'PostToolUse',
      });
    }

    return state;
  }

  /**
   * Writes state.json to <cliHome>/state.json and, if withSecretsBinaryInstalled() was called,
   * copies the mock binary to <cliHome>/bin/sonar-secrets.
   */
  writeTo(cliHome: string, keychainJsonPath: string): Promise<void> {
    const state = this.build();
    mkdirSync(cliHome, { recursive: true });
    writeFileSync(join(cliHome, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');

    if (this.keychainTokens.length > 0) {
      const tokens: Record<string, string> = {};
      for (const { serverURL, token, org } of this.keychainTokens) {
        tokens[toKeychainAccount(serverURL, org)] = token;
      }
      writeFileSync(keychainJsonPath, JSON.stringify({ tokens }, null, 2), 'utf-8');
    }

    if (!this._installSecretsBinary) {
      return Promise.resolve();
    }

    const binDir = join(cliHome, 'bin');
    mkdirSync(binDir, { recursive: true });

    const source = resolveSecretsBinarySource();
    const destPath = join(binDir, 'sonar-secrets');
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
    return Promise.resolve();
  }
}
