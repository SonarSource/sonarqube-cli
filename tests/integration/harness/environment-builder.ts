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

import { buildLocalCagBinaryName } from '../../../src/cli/commands/_common/install/context-augmentation';
import { buildLocalBinaryName } from '../../../src/cli/commands/_common/install/secrets';
import { SONAR_SECRETS_DIST_PREFIX } from '../../../src/lib/config-constants.js';
import {
  CONTEXT_AUGMENTATION_BINARY_NAME,
  SECRETS_BINARY_NAME,
} from '../../../src/lib/install-types.js';
import { generateKeychainAccount } from '../../../src/lib/keychain';
import { detectPlatform } from '../../../src/lib/platform-detector.js';
import {
  SONAR_CONTEXT_AUGMENTATION_VERSION,
  SONAR_SECRETS_VERSION,
} from '../../../src/lib/signatures.js';
import { buildDownloadUrl } from '../../../src/lib/sonarsource-releases.js';
import type { CliState } from '../../../src/lib/state.js';
import { getDefaultState } from '../../../src/lib/state.js';
import { IS_WINDOWS } from './platform';

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
  private _installCagBinary = false;
  private _cagInitExitCode = 0;
  private _cagSkillExitCode = 0;
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
   * Writes a stub sonar-context-augmentation script under <cliHome>/bin so the
   * `sonar context` passthrough and the integrate-flow CAG step can run without
   * a real CAG binary.
   *
   * The stub:
   *   - prints `sonar-context-augmentation 0.0.0-test` for `--version` (so the
   *     installer's verifyInstallation() probe succeeds)
   *   - appends one JSON line per invocation (argv + selected env vars) to
   *     <cliHome>/cag-invocations.jsonl, which tests can read back to assert
   *     the wrapper invoked the binary as expected
   *   - exits with `_cagInitExitCode` for the `init` subcommand and
   *     `_cagSkillExitCode` for the `skill` subcommand (defaults: 0/0).
   */
  withContextAugmentationBinaryInstalled(
    options: { initExitCode?: number; skillExitCode?: number } = {},
  ): this {
    this._installCagBinary = true;
    this._cagInitExitCode = options.initExitCode ?? 0;
    this._cagSkillExitCode = options.skillExitCode ?? 0;
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
   * Required for `analyze agentic` and `analyze` (full pipeline) to run Agentic Analysis.
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
      state.tools ??= { installed: [] };
      state.tools.installed.push({
        name: 'sonar-secrets',
        version: SONAR_SECRETS_VERSION,
        path: buildLocalBinaryName(detectPlatform()),
        installedAt: new Date().toISOString(),
        installedByCliVersion: 'integration-test',
      });
    }

    if (this._installCagBinary) {
      state.tools ??= { installed: [] };
      state.tools.installed.push({
        name: CONTEXT_AUGMENTATION_BINARY_NAME,
        version: SONAR_CONTEXT_AUGMENTATION_VERSION,
        path: buildLocalCagBinaryName(detectPlatform()),
        installedAt: new Date().toISOString(),
        installedByCliVersion: 'integration-test',
      });
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

    if (this._installCagBinary) {
      this.writeCagStub(cliHome);
    }
  }

  /**
   * Writes a stub sonar-context-augmentation script. Records each invocation
   * (argv + SONAR_TOKEN) to <cliHome>/cag-invocations.jsonl, one JSON object per line.
   */
  private writeCagStub(cliHome: string): void {
    const binDir = join(cliHome, 'bin');
    mkdirSync(binDir, { recursive: true });

    const versionedName = buildLocalCagBinaryName(detectPlatform());
    const destPath = join(binDir, versionedName);
    const sentinelPath = join(cliHome, 'cag-invocations.jsonl');
    const initExit = this._cagInitExitCode;
    const skillExit = this._cagSkillExitCode;

    if (IS_WINDOWS) {
      writeFileSync(destPath, buildWindowsCagStub(sentinelPath, initExit, skillExit));
    } else {
      writeFileSync(destPath, buildPosixCagStub(sentinelPath, initExit, skillExit));
      chmodSync(destPath, EXECUTABLE_PERMS);
    }
  }
}

const EXECUTABLE_PERMS = 0o755;

const POSIX_QUOTE_ESCAPE = String.raw`'\''`;

function shellQuote(s: string): string {
  const escaped = s.replaceAll("'", POSIX_QUOTE_ESCAPE);
  return "'" + escaped + "'";
}

function buildPosixCagStub(sentinelPath: string, initExit: number, skillExit: number): string {
  // sed expression that JSON-escapes a string by doubling backslashes then
  // escaping double-quotes. Written with String.raw so backslashes survive
  // the TS string literal unchanged.
  const sedEscape = String.raw`sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'`;
  return [
    '#!/bin/sh',
    `INVOCATIONS=${shellQuote(sentinelPath)}`,
    'if [ "$1" = "--version" ]; then',
    '  echo "sonar-context-augmentation 0.0.0-test"',
    '  exit 0',
    'fi',
    `json_esc() { printf '%s' "$1" | ${sedEscape}; }`,
    'argv_json="["',
    'first=1',
    'for a in "$@"; do',
    '  esc=$(json_esc "$a")',
    '  if [ "$first" -eq 1 ]; then argv_json="${argv_json}\\"${esc}\\""; first=0; else argv_json="${argv_json},\\"${esc}\\""; fi',
    'done',
    'argv_json="${argv_json}]"',
    'token_esc=$(json_esc "${SONAR_TOKEN-}")',
    'echo "{\\"argv\\":${argv_json},\\"env\\":{\\"SONAR_TOKEN\\":\\"${token_esc}\\"}}" >> "$INVOCATIONS"',
    `if [ "$1" = "init" ]; then exit ${initExit}; fi`,
    `if [ "$1" = "skill" ]; then exit ${skillExit}; fi`,
    'exit 0',
    '',
  ].join('\n');
}

function buildWindowsCagStub(sentinelPath: string, initExit: number, skillExit: number): string {
  // CMD batch wrapper that delegates JSON serialization to PowerShell.
  // PowerShell handles argv quoting and JSON escaping natively.
  const psSentinel = sentinelPath.replaceAll(`'`, `''`);
  const psCommand = String.raw`$entry = @{ argv = $args; env = @{ SONAR_TOKEN = $env:SONAR_TOKEN } } | ConvertTo-Json -Compress; Add-Content -LiteralPath '${psSentinel}' -Value $entry`;
  return [
    '@echo off',
    'if "%~1"=="--version" (echo sonar-context-augmentation 0.0.0-test & exit /b 0)',
    `powershell -NoProfile -Command "${psCommand}" %*`,
    `if "%~1"=="init" exit /b ${initExit}`,
    `if "%~1"=="skill" exit /b ${skillExit}`,
    'exit /b 0',
  ].join('\r\n');
}
