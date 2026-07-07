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
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEPENDENCY_ARTIFACTS_DIR } from '../../../build-scripts/dependency-artifacts-path.js';
import { version as CURRENT_CLI_VERSION } from '../../../package.json';
import {
  type BinarySpec,
  buildLocalBinaryName,
} from '../../../src/cli/commands/_common/install/binary';
import { buildLocalCagBinaryName } from '../../../src/cli/commands/_common/install/context-augmentation';
import { SCA_SCANNER_SPEC } from '../../../src/cli/commands/_common/install/sca-scanner';
import { SECRETS_SPEC } from '../../../src/cli/commands/_common/install/secrets';
import { CONTEXT_AUGMENTATION_FEATURE_ID } from '../../../src/cli/commands/integrate/_common/features/context-augmentation-feature';
import { recordInstalledFeature } from '../../../src/cli/commands/integrate/_common/registry/installation-recorder';
import type { IntegrationDeclaration } from '../../../src/cli/commands/integrate/_common/registry/types';
import { SQAA_HOOK_FEATURE_ID } from '../../../src/cli/commands/integrate/_common/sqaa-entitlement';
import { CLAUDE_INTEGRATION_ID } from '../../../src/cli/commands/integrate/claude/declaration';
import { canonicalizePath } from '../../../src/lib/fs-utils';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '../../../src/lib/install-types.js';
import { generateKeychainAccount } from '../../../src/lib/keychain';
import { detectPlatform } from '../../../src/lib/platform-detector.js';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '../../../src/lib/signatures.js';
import { buildDownloadUrl } from '../../../src/lib/sonarsource-releases.js';
import type {
  CliState,
  InstalledIntegration,
  InstalledIntegrationDependency,
  InstalledTool,
  IntegrationScope,
} from '../../../src/lib/state.js';
import { getDefaultState } from '../../../src/lib/state.js';
import { IS_WINDOWS } from './platform';

function resolveBinaryFixturePath(fixture: BinarySpec): string {
  const platform = detectPlatform();
  const downloadUrl = buildDownloadUrl(fixture.name, fixture.version, fixture.distPrefix, platform);
  const filename = downloadUrl.split('/').at(-1)!;
  return join(DEPENDENCY_ARTIFACTS_DIR, filename);
}

interface SqaaFeatureConfig {
  projectRoot: string;
  projectKey: string;
  orgKey?: string;
  serverUrl?: string;
  targetRoot?: string;
  repoRoot?: string;
}

interface ContextAugmentationSkillConfig {
  projectRoot: string;
  projectKey: string;
  orgKey?: string;
  serverUrl?: string;
  scaEnabled?: boolean;
}

function getOrCreateClaudeIntegration(state: CliState): InstalledIntegration {
  const timestamp = new Date().toISOString();
  let integration = state.integrations.installed.find(
    (entry) => entry.integrationId === CLAUDE_INTEGRATION_ID,
  );
  if (!integration) {
    integration = {
      id: randomUUID(),
      integrationId: CLAUDE_INTEGRATION_ID,
      installedByCliVersion: 'integration-test',
      installedAt: timestamp,
      updatedByCliVersion: 'integration-test',
      updatedAt: timestamp,
      features: [],
    };
    state.integrations.installed.push(integration);
  }
  return integration;
}

function recordContextAugmentationFeature(
  state: CliState,
  args: {
    projectRoot: string;
    projectKey: string;
    orgKey?: string;
    serverUrl?: string;
    scaEnabled: boolean;
  },
): void {
  const integration = getOrCreateClaudeIntegration(state);
  const timestamp = integration.installedAt;

  integration.features.push({
    featureId: CONTEXT_AUGMENTATION_FEATURE_ID,
    scope: 'project',
    targetRoot: args.projectRoot,
    installedByCliVersion: 'integration-test',
    installedAt: timestamp,
    updatedByCliVersion: 'integration-test',
    updatedAt: timestamp,
    dependencies: [{ id: CONTEXT_AUGMENTATION_BINARY_NAME }],
    resources: [],
    operations: [],
    attrs: {
      orgKey: args.orgKey ?? null,
      projectKey: args.projectKey,
      scaEnabled: args.scaEnabled,
      serverUrl: args.serverUrl ?? null,
    },
  });
}

function recordSqaaHookFeature(
  state: CliState,
  args: {
    projectRoot: string;
    projectKey: string;
    orgKey?: string;
    serverUrl?: string;
    targetRoot?: string;
    repoRoot?: string;
  },
): void {
  const integration = getOrCreateClaudeIntegration(state);
  const timestamp = integration.installedAt;

  integration.features.push({
    featureId: SQAA_HOOK_FEATURE_ID,
    scope: 'project',
    targetRoot: args.targetRoot ?? args.projectRoot,
    installedByCliVersion: 'integration-test',
    installedAt: timestamp,
    updatedByCliVersion: 'integration-test',
    updatedAt: timestamp,
    dependencies: [],
    resources: [],
    operations: [],
    attrs: {
      orgKey: args.orgKey ?? null,
      projectKey: args.projectKey,
      serverUrl: args.serverUrl ?? null,
      ...(args.repoRoot ? { repoRoot: args.repoRoot } : {}),
    },
  });
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
  private _cagPrintSkillExitCode = 0;
  private _cagPrintSkillEmpty = false;
  private _cagStopAllExitCode = 0;
  private _cagSentinelPath?: string;
  private _cagStdoutLine?: string;
  private _cagStderrLine?: string;
  private _installScaScannerBinary = false;
  private _rawStateJson?: string;
  private _telemetryEnabled = false;
  private _dockerMockRunning?: boolean;
  private _dockerMockBinDir?: string;
  private readonly keychainTokens: Array<{ serverURL: string; token: string; org?: string }> = [];
  private readonly sqaaFeatures: SqaaFeatureConfig[] = [];
  private readonly contextAugmentationSkills: ContextAugmentationSkillConfig[] = [];
  private readonly installedFeatureSeeds: Array<(state: CliState) => void> = [];

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
      printSkillExitCode?: number;
      printSkillEmpty?: boolean;
      stopAllExitCode?: number;
      stdoutLine?: string;
      stderrLine?: string;
    } = {},
  ): this {
    this._installCagBinary = true;
    this._cagInitExitCode = options.initExitCode ?? 0;
    this._cagSkillExitCode = options.skillExitCode ?? 0;
    this._cagPrintSkillExitCode = options.printSkillExitCode ?? 0;
    this._cagPrintSkillEmpty = options.printSkillEmpty ?? false;
    this._cagStopAllExitCode = options.stopAllExitCode ?? 0;
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
    const env: Record<string, string> = {};

    if (this._installCagBinary && this._cagSentinelPath) {
      env.CAG_STUB_SENTINEL = this._cagSentinelPath;
      env.CAG_STUB_INIT_EXIT = String(this._cagInitExitCode);
      env.CAG_STUB_SKILL_EXIT = String(this._cagSkillExitCode);
      env.CAG_STUB_PRINT_SKILL_EXIT = String(this._cagPrintSkillExitCode);
      env.CAG_STUB_STOP_ALL_EXIT = String(this._cagStopAllExitCode);
      if (this._cagStdoutLine !== undefined) env.CAG_STUB_STDOUT_LINE = this._cagStdoutLine;
      if (this._cagStderrLine !== undefined) env.CAG_STUB_STDERR_LINE = this._cagStderrLine;
    }

    if (this._cagPrintSkillEmpty) env.CAG_STUB_PRINT_SKILL_EMPTY = '1';

    return env;
  }

  /** Docker mock bin dir to prepend to PATH; set after writeTo() runs. */
  get dockerMockBinDir(): string | undefined {
    return this._dockerMockBinDir;
  }

  get telemetryEnabled(): boolean {
    return this._telemetryEnabled;
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
   * Enables telemetry in the generated state (off by default for integration tests).
   * Use when a test needs to assert telemetry side effects such as telemetry-events.ndjson.
   * Pair with extraEnv `__SQ_CLI_TELEMETRY_FLUSH__=1` so the sink is written but the
   * detached flush worker never spawns, and nothing is POSTed to the telemetry endpoint.
   */
  withTelemetryEnabled(): this {
    this._telemetryEnabled = true;
    return this;
  }

  /**
   * Installs a fake `docker` binary in the isolated test environment.
   * When called, `detectContainerRuntime()` will find it and MCP running-status
   * checks will work without a real Docker daemon.
   * `mcpRunning` controls whether `docker ps` reports the MCP container as active.
   */
  withDockerMock(mcpRunning = false): this {
    this._dockerMockRunning = mcpRunning;
    return this;
  }

  /**
   * Registers a declaratively tracked SQAA hook feature for a project.
   * Required for `analyze agentic` and `analyze` (full pipeline) to run Agentic Analysis.
   */
  withSqaaFeature(
    projectRoot: string,
    projectKey: string,
    orgKey?: string,
    serverUrl?: string,
    options?: { targetRoot?: string; repoRoot?: string },
  ): this {
    this.sqaaFeatures.push({
      projectRoot,
      projectKey,
      orgKey,
      serverUrl,
      targetRoot: options?.targetRoot,
      repoRoot: options?.repoRoot,
    });
    return this;
  }

  /**
   * Registers a declaratively tracked Context Augmentation feature for a
   * project. This mirrors the state consumed by `sonar context`.
   */
  withContextAugmentationSkill(
    projectRoot: string,
    projectKey: string,
    orgKey?: string,
    serverUrl?: string,
    scaEnabled = false,
  ): this {
    this.contextAugmentationSkills.push({
      projectRoot,
      projectKey,
      orgKey,
      serverUrl,
      scaEnabled,
    });
    return this;
  }

  /**
   * Seeds a previously-installed integration feature in the state file so
   * `shouldInstall` state probes (e.g. `isFeatureInstalledGloballyForProject`) see it as
   * already installed.
   */
  withInstalledIntegrationFeature<TOptions>(
    integration: IntegrationDeclaration<TOptions>,
    featureId: string,
    scope: IntegrationScope = 'global',
    targetRoot = '',
  ): this {
    this.installedFeatureSeeds.push((state) => {
      const feature = integration.features.find((entry) => entry.id === featureId);
      if (!feature) {
        throw new Error(`Unknown feature ${integration.id}.${featureId}`);
      }
      recordInstalledFeature(
        state,
        { targetRoot, scope, executionMode: 'install', resolvedDependencies: new Map(), attrs: {} },
        integration,
        feature,
        { dependencies: [], resources: [], operations: [] },
      );
    });
    return this;
  }

  build(binDir?: string): CliState {
    // Default to the current CLI version so post-update is a no-op. Tests that
    // need to exercise the upgrade migration inject a stale version via
    // withRawState().
    const state = getDefaultState(CURRENT_CLI_VERSION);

    // Telemetry is off by default for integration tests; opt in via withTelemetryEnabled().
    state.telemetry.enabled = this._telemetryEnabled;

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

    // Match production: recordInstallationInState stores the absolute installed
    // path. binDir is omitted only by the no-arg build() callers that do not
    // care about path resolution.
    const resolvePath = (name: string): string => (binDir ? join(binDir, name) : name);

    const installed: InstalledTool[] = [];
    const installedDependencies: InstalledIntegrationDependency[] = [];
    if (this._installSecretsBinary) {
      const binaryPath = resolvePath(buildLocalBinaryName(SECRETS_SPEC, detectPlatform()));
      installed.push({
        name: SECRETS_SPEC.name,
        version: SECRETS_SPEC.version,
        path: binaryPath,
        installedAt: new Date().toISOString(),
        installedByCliVersion: 'integration-test',
      });
      installedDependencies.push({
        id: SECRETS_SPEC.name,
        dependencyType: 'sonarsource-binary',
        version: SECRETS_SPEC.version,
        path: binaryPath,
        updatedAt: new Date().toISOString(),
        updatedByCliVersion: 'integration-test',
      });
    }
    if (this._installCagBinary) {
      const binaryPath = resolvePath(buildLocalCagBinaryName(detectPlatform()));
      installed.push({
        name: CONTEXT_AUGMENTATION_BINARY_NAME,
        version: SONAR_CONTEXT_AUGMENTATION_VERSION,
        path: binaryPath,
        installedAt: new Date().toISOString(),
        installedByCliVersion: 'integration-test',
      });
      installedDependencies.push({
        id: CONTEXT_AUGMENTATION_BINARY_NAME,
        dependencyType: 'context-augmentation-binary',
        version: SONAR_CONTEXT_AUGMENTATION_VERSION,
        path: binaryPath,
        updatedAt: new Date().toISOString(),
        updatedByCliVersion: 'integration-test',
      });
    }
    if (this._installScaScannerBinary) {
      installed.push({
        name: SCA_SCANNER_SPEC.name,
        version: SCA_SCANNER_SPEC.version,
        path: resolvePath(buildLocalBinaryName(SCA_SCANNER_SPEC, detectPlatform())),
        installedAt: new Date().toISOString(),
        installedByCliVersion: 'integration-test',
      });
    }
    if (installed.length > 0) {
      state.tools = { installed };
    }
    if (installedDependencies.length > 0) {
      state.dependencies = { installed: installedDependencies };
    }

    for (const feature of this.sqaaFeatures) {
      // Resolve symlinks so the stored path matches process.cwd() in the CLI subprocess
      // (e.g. /var/folders/... → /private/var/folders/... on macOS)
      const resolvedRoot = canonicalizePath(feature.projectRoot);
      recordSqaaHookFeature(state, {
        projectRoot: resolvedRoot,
        projectKey: feature.projectKey,
        orgKey: feature.orgKey ?? this.activeConnectionOrgKey,
        serverUrl: feature.serverUrl ?? this.activeConnectionUrl,
        targetRoot: feature.targetRoot,
        repoRoot: feature.repoRoot,
      });
    }

    for (const skill of this.contextAugmentationSkills) {
      const resolvedRoot = canonicalizePath(skill.projectRoot);
      recordContextAugmentationFeature(state, {
        projectRoot: resolvedRoot,
        projectKey: skill.projectKey,
        orgKey: skill.orgKey ?? this.activeConnectionOrgKey,
        serverUrl: skill.serverUrl ?? this.activeConnectionUrl,
        scaEnabled: skill.scaEnabled ?? false,
      });
    }

    for (const seed of this.installedFeatureSeeds) {
      seed(state);
    }

    return state;
  }

  /**
   * Writes state.json and the keychain JSON file, and if withSecretsBinaryInstalled() was called, copies the mock binary.
   */
  writeTo(cliHome: string, keychainFile: string): void {
    mkdirSync(cliHome, { recursive: true });
    const stateJson =
      this._rawStateJson ?? JSON.stringify(this.build(join(cliHome, 'bin')), null, 2);
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

    if (this._dockerMockRunning !== undefined && !IS_WINDOWS) {
      const mockBinDir = join(cliHome, 'mock-bin');
      mkdirSync(mockBinDir, { recursive: true });
      const psOutput = this._dockerMockRunning ? 'abc123' : '';
      const script = [
        '#!/bin/bash',
        'case "$1" in',
        '  info) exit 0 ;;',
        `  ps) echo "${psOutput}" ;;`,
        '  *) exit 0 ;;',
        'esac',
      ].join('\n');
      writeFileSync(join(mockBinDir, 'docker'), script, { mode: EXECUTABLE_PERMS });
      this._dockerMockBinDir = mockBinDir;
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
