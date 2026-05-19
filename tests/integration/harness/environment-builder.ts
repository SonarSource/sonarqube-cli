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

import { DEPENDENCY_ARTIFACTS_DIR } from '../../../build-scripts/dependency-artifacts-path.js';
import {
  type BinarySpec,
  buildLocalBinaryName,
} from '../../../src/cli/commands/_common/install/binary';
import { buildLocalCagBinaryName } from '../../../src/cli/commands/_common/install/context-augmentation';
import { SCA_SCANNER_SPEC } from '../../../src/cli/commands/_common/install/sca-scanner';
import { SECRETS_SPEC } from '../../../src/cli/commands/_common/install/secrets';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '../../../src/lib/install-types.js';
import { generateKeychainAccount } from '../../../src/lib/keychain';
import { detectPlatform } from '../../../src/lib/platform-detector.js';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '../../../src/lib/signatures.js';
import { buildDownloadUrl } from '../../../src/lib/sonarsource-releases.js';
import type { CliState, InstalledTool } from '../../../src/lib/state.js';
import { getDefaultState } from '../../../src/lib/state.js';
import { IS_WINDOWS } from './platform';

function resolveBinaryFixturePath(fixture: BinarySpec): string {
  const platform = detectPlatform();
  const downloadUrl = buildDownloadUrl(fixture.name, fixture.version, fixture.distPrefix, platform);
  const filename = downloadUrl.split('/').at(-1)!;
  return join(DEPENDENCY_ARTIFACTS_DIR, filename);
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
  private _cagSentinelPath?: string;
  private _cagStdoutLine?: string;
  private _cagStderrLine?: string;
  private _installScaScannerBinary = false;
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
   * Copies the mock binary from tests/integration/resources/dependency-artifacts/
   * into <tempDir>/bin/sonar-secrets.
   */
  withSecretsBinaryInstalled(): this {
    this._installSecretsBinary = true;
    return this;
  }

  /**
   * Installs the pre-compiled CAG stub binary (built by
   * `bun run pretest:integration`) into <cliHome>/bin so the `sonar context`
   * passthrough and the integrate-flow CAG step can run without a real CAG
   * binary. Uses a real native executable rather than a shell/CMD script so
   * Windows can spawn it as a PE.
   *
   * Each invocation appends one JSON line (argv + selected env vars) to
   * <cliHome>/cag-invocations.jsonl, which tests can read back to assert
   * the wrapper invoked the binary as expected. Per-subcommand exit codes
   * are passed to the stub via env vars; see `getExtraEnv()`.
   */
  withContextAugmentationBinaryInstalled(
    options: {
      initExitCode?: number;
      skillExitCode?: number;
      stdoutLine?: string;
      stderrLine?: string;
    } = {},
  ): this {
    this._installCagBinary = true;
    this._cagInitExitCode = options.initExitCode ?? 0;
    this._cagSkillExitCode = options.skillExitCode ?? 0;
    this._cagStdoutLine = options.stdoutLine;
    this._cagStderrLine = options.stderrLine;
    return this;
  }

  /**
   * Ensures sca-scanner-cli is available inside the isolated test environment.
   * Copies the cached binary from tests/integration/resources/dependency-artifacts/
   * into <tempDir>/bin/ and records it in state.tools.installed.
   */
  withScaScannerBinaryInstalled(): this {
    this._installScaScannerBinary = true;
    return this;
  }

  /**
   * Returns env vars the harness should merge into every CLI invocation.
   * Currently used to parameterize the CAG stub binary (sentinel path +
   * per-subcommand exit codes). Populated after `writeTo()` runs because the
   * sentinel path depends on the harness's cliHome.
   */
  getExtraEnv(): Record<string, string> {
    if (!this._installCagBinary || !this._cagSentinelPath) {
      return {};
    }
    return {
      CAG_STUB_SENTINEL: this._cagSentinelPath,
      CAG_STUB_INIT_EXIT: String(this._cagInitExitCode),
      CAG_STUB_SKILL_EXIT: String(this._cagSkillExitCode),
      ...(this._cagStdoutLine !== undefined && { CAG_STUB_STDOUT_LINE: this._cagStdoutLine }),
      ...(this._cagStderrLine !== undefined && { CAG_STUB_STDERR_LINE: this._cagStderrLine }),
    };
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

    const installed: InstalledTool[] = [];
    if (this._installSecretsBinary) {
      installed.push({
        name: SECRETS_SPEC.name,
        version: SECRETS_SPEC.version,
        path: buildLocalBinaryName(SECRETS_SPEC, detectPlatform()),
        installedAt: new Date().toISOString(),
        installedByCliVersion: 'integration-test',
      });
    }
    if (this._installCagBinary) {
      installed.push({
        name: CONTEXT_AUGMENTATION_BINARY_NAME,
        version: SONAR_CONTEXT_AUGMENTATION_VERSION,
        path: buildLocalCagBinaryName(detectPlatform()),
        installedAt: new Date().toISOString(),
        installedByCliVersion: 'integration-test',
      });
    }
    if (this._installScaScannerBinary) {
      installed.push({
        name: SCA_SCANNER_SPEC.name,
        version: SCA_SCANNER_SPEC.version,
        path: buildLocalBinaryName(SCA_SCANNER_SPEC, detectPlatform()),
        installedAt: new Date().toISOString(),
        installedByCliVersion: 'integration-test',
      });
    }
    if (installed.length > 0) {
      state.tools = { installed };
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
      copyBinaryFixtureInto(
        cliHome,
        SECRETS_SPEC,
        buildLocalBinaryName(SECRETS_SPEC, detectPlatform()),
      );
    }
    if (this._installScaScannerBinary) {
      copyBinaryFixtureInto(
        cliHome,
        SCA_SCANNER_SPEC,
        buildLocalBinaryName(SCA_SCANNER_SPEC, detectPlatform()),
      );
    }

    if (this._installCagBinary) {
      this.copyCagStub(cliHome);
      this._cagSentinelPath = join(cliHome, 'cag-invocations.jsonl');
    }
  }

  /**
   * Copies the pre-compiled CAG stub binary (built by
   * `bun run pretest:integration`) into <cliHome>/bin under the CAG-versioned
   * filename. A real native executable rather than a shell/CMD script so
   * Windows can spawn it as a PE. Per-test parameters (sentinel path,
   * subcommand exit codes) reach the stub via env vars — see `getExtraEnv()`.
   */
  private copyCagStub(cliHome: string): void {
    const binDir = join(cliHome, 'bin');
    mkdirSync(binDir, { recursive: true });

    const versionedName = buildLocalCagBinaryName(detectPlatform());
    const destPath = join(binDir, versionedName);
    if (existsSync(destPath)) {
      return;
    }

    const stubFilename = IS_WINDOWS ? 'cag-stub.exe' : 'cag-stub';
    const source = join(import.meta.dir, '..', 'resources', stubFilename);
    if (!existsSync(source)) {
      throw new Error(
        `CAG stub binary not found at: ${source}\n` +
          `Run 'bun run pretest:integration' to compile it.`,
      );
    }
    copyFileSync(source, destPath);
    if (!IS_WINDOWS) {
      chmodSync(destPath, EXECUTABLE_PERMS);
    }
  }
}

const EXECUTABLE_PERMS = 0o755;

function copyBinaryFixtureInto(cliHome: string, fixture: BinarySpec, versionedName: string): void {
  const binDir = join(cliHome, 'bin');
  mkdirSync(binDir, { recursive: true });

  const source = resolveBinaryFixturePath(fixture);
  const destPath = join(binDir, versionedName);
  if (existsSync(destPath)) return;
  if (!existsSync(source)) {
    throw new Error(
      `${fixture.name} binary not found at: ${source}\n` +
        `Run 'bun run pretest:integration' to download it.`,
    );
  }
  copyFileSync(source, destPath);
  chmodSync(destPath, 0o755);
}
