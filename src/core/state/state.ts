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
 * State management types for sonarqube-cli
 * Manages persistent state in ~/.sonar/sonarqube-cli/state.json
 */

import { randomUUID } from 'node:crypto';

import type { Distribution } from '@/core/host/distribution.ts';
import type { CallerAgent } from '@/core/host/environment/agent-detector.ts';

/**
 * Region for SonarCloud instances
 */
export type CloudRegion = 'eu' | 'us';

/**
 * Server type classification
 */
export type ServerType = 'cloud' | 'on-premise';

/**
 * Hook type for agent integration
 */
export type HookType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreInvocation'
  | 'PostInvocation';

/**
 * Single authentication connection
 */
export interface AuthConnection {
  /** Unique identifier hash based on serverUrl and orgKey */
  id: string;
  /** Server type: SonarQube Cloud or Server instance */
  type: ServerType;
  /** Server URL */
  serverUrl: string;
  /** Cloud region (only for cloud type) */
  region?: CloudRegion;
  /** Organization key (only for cloud type) */
  orgKey?: string;
  /**
   * Server-generated token name, present only for connections created through
   * the browser-based OAuth flow. Used during logout to revoke the token on
   * the server side via `/api/user_tokens/revoke`. Absent for connections
   * created with older CLI versions that did not capture the token name.
   */
  tokenName?: string;
  /** Timestamp when authenticated */
  authenticatedAt: string;
  /** UUID of the user on the server side (fetched at auth time) */
  userUuid?: string | null;
  /** UUID of the SonarQube Cloud organization (fetched at auth time, SQC only) */
  organizationUuidV4?: string | null;
  /** UUID of the SonarQube Cloud enterprise that owns the org (fetched at auth time, SQC only) */
  enterpriseUuid?: string | null;
  /** Installation ID of the SonarQube Server (fetched at auth time, SQS only) */
  sqsInstallationId?: string | null;
  /**
   * True when this connection was recorded from env-var auth (see
   * `recordConnectionFromAuth`), not `sonar auth login`. `resolveAuth()` always
   * prefers env vars when set, so an env-recorded connection is never the one
   * actually used to fetch a keychain token — even if a keychain entry happens
   * to exist for the same server/org from an earlier login.
   */
  envOnly?: boolean;
}

/**
 * Authentication state
 */
export interface AuthState {
  /** Whether user is authenticated */
  isAuthenticated: boolean;
  /** List of configured connections */
  connections: AuthConnection[];
  /** ID of currently active connection */
  activeConnectionId?: string;
}

/**
 * Installed hook metadata (legacy — kept for migration compatibility)
 */
export interface InstalledHook {
  /** Hook name/identifier */
  name: string;
  /** Hook type */
  type: HookType;
  /** Timestamp when installed */
  installedAt: string;
}

/**
 * Installed skill metadata (legacy — kept for migration compatibility)
 */
export interface InstalledSkill {
  /** Skill name/identifier */
  name: string;
  /** Timestamp when installed */
  installedAt: string;
}

/**
 * Base fields shared by all agent extension entries
 */
export interface BaseAgentExtension {
  /** Unique identifier for this entry */
  id: string;
  /** Agent that owns this extension (e.g. 'claude-code') */
  agentId: string;
  /** Absolute path to the project root where the extension was installed */
  projectRoot: string;
  /** True when installed in the user's global Claude dir (~/) instead of the project dir */
  global: boolean;
  /** SonarQube project key associated with this extension, if known */
  projectKey?: string;
  /** Organization key (SonarCloud only) */
  orgKey?: string;
  /** Server URL */
  serverUrl?: string;
  /** CLI version that last wrote this entry */
  updatedByCliVersion: string;
  /** ISO timestamp of the last update */
  updatedAt: string;
}

/**
 * A Claude Code hook installed for a specific project
 */
export interface HookExtension extends BaseAgentExtension {
  kind: 'hook';
  /** Hook script name (e.g. 'sonar-secrets', 'sonar-sqaa') */
  name: string;
  /** Claude Code hook type */
  hookType: HookType;
}

/**
 * A Claude Code skill installed for a specific project
 */
export interface SkillExtension extends BaseAgentExtension {
  kind: 'skill';
  /** Skill name */
  name: string;
  /** Skill version, if versioned */
  version?: string;
  /** Whether SCA was enabled on the connection when the skill was installed. */
  scaEnabled?: boolean;
}

/**
 * A custom instructions markdown file installed for an agent.
 * The on-disk path is reconstructable from `agentId`, `projectRoot`, `global`,
 * and `name`, so we don't store it here (consistent with `HookExtension`).
 */
export interface InstructionsExtension extends BaseAgentExtension {
  kind: 'instructions';
  /** Logical name for the instructions entry (e.g. 'sonar-prompt-secrets') */
  name: string;
}

/**
 * Union of all extension types stored in the registry
 */
export type AgentExtension = HookExtension | SkillExtension | InstructionsExtension;

/**
 * Agent hooks configuration
 */
export interface AgentHooks {
  /** List of installed hooks */
  installed: InstalledHook[];
}

/**
 * Agent skills configuration
 */
export interface AgentSkills {
  /** List of installed skills */
  installed: InstalledSkill[];
}

/**
 * Configuration for a single agent (Claude Code, etc.)
 */
export interface AgentConfig {
  /** Whether agent is configured */
  configured: boolean;
  /** Timestamp when configured */
  configuredAt?: string;
  /** CLI version that performed configuration */
  configuredByCliVersion?: string;
  /** Timestamp when hooks were last auto-migrated */
  migratedAt?: string;
  /** Hooks installed for this agent */
  hooks: AgentHooks;
  /** Skills installed for this agent */
  skills: AgentSkills;
}

/**
 * All agents configuration
 */
export interface AgentsState {
  /** Claude Code agent configuration */
  'claude-code': AgentConfig;
  /** Future agents can be added here */
  [key: string]: AgentConfig;
}

/**
 * Cached CLI update-check metadata for throttled background version fetches.
 */
export interface CliUpdateCheckState {
  /** ISO timestamp of the last remote stable-version fetch */
  lastCheckedAt?: string;
  /** Latest stable version string returned by the last fetch */
  latestVersion?: string;
}

/**
 * CLI configuration
 */
export interface CliConfig {
  /** Current CLI version */
  cliVersion: string;
  /** Throttled update-check cache (remote fetch at most once per day) */
  updateCheck?: CliUpdateCheckState;
  /** Throttle for the Vortex entitlement-loss warning shown by per-edit hooks */
  vortexEntitlementLossNotice?: VortexEntitlementLossNoticeState;
  /** Last CLI version that warned about each invoked Beta command */
  betaCommandWarnings?: Record<string, string>;
}

export interface VortexEntitlementLossNoticeState {
  /** ISO timestamp of the last entitlement-loss warning emitted by a hook */
  lastWarnedAt?: string;
}

/**
 * Installed tool metadata
 */
export interface InstalledTool {
  /** Tool name identifier */
  name: string;
  /** Tool version */
  version: string;
  /** Installation path */
  path: string;
  /** Timestamp when installed */
  installedAt: string;
  /** CLI version that performed installation */
  installedByCliVersion: string;
}

/**
 * Tools installation state
 */
export interface ToolsState {
  /** List of installed tools */
  installed: InstalledTool[];
}

/**
 * Installed dependency metadata shared across declarative integration features.
 */
export interface InstalledIntegrationDependency {
  /** Stable dependency identifier from the integration declaration */
  id: string;
  /** Dependency type from the integration declaration */
  dependencyType: string;
  /** Dependency declaration version, when versioned */
  version?: string;
  /** Resolved path for dependencies materialized on disk */
  path?: string;
  /** CLI version that last updated this dependency */
  updatedByCliVersion: string;
  /** ISO timestamp of the last update */
  updatedAt: string;
}

/**
 * Shared dependency installation state.
 */
export interface DependenciesState {
  /** Installed dependencies shared by declarative integrations */
  installed: InstalledIntegrationDependency[];
}

/**
 * Scope where an integration feature was installed.
 */
export type IntegrationScope = 'project' | 'global';

/**
 * Basic scalar attributes carried by integration feature state.
 */
export type IntegrationStateAttribute = string | number | boolean | null;

/**
 * Installed resource metadata for a declarative integration feature.
 */
export interface InstalledIntegrationResource {
  /** Stable resource identifier from the integration declaration */
  id: string;
  /** Resource type from the integration declaration */
  resourceType: string;
  /** Resource declaration version, when versioned */
  version?: string;
  /** Resolved path for resources materialized on disk */
  path?: string;
  /** CLI version that last updated this resource */
  updatedByCliVersion: string;
  /** ISO timestamp of the last update */
  updatedAt: string;
}

/**
 * Installed operation metadata for a declarative integration feature.
 */
export interface InstalledIntegrationOperation {
  /** Stable operation identifier from the integration declaration */
  id: string;
  /** Operation declaration version, when versioned */
  version?: string;
  /** CLI version that last ran this operation */
  updatedByCliVersion: string;
  /** ISO timestamp of the last run */
  updatedAt: string;
}

/**
 * Dependency reference stored on an installed declarative integration feature.
 */
export interface InstalledIntegrationDependencyReference {
  /** Stable dependency identifier from the integration declaration */
  id: string;
}

/**
 * Recorded state for an active subfeature nested inside a {@link InstalledIntegrationFeature}.
 */
export interface InstalledSubfeature {
  /** Subfeature identifier from the integration declaration */
  featureId: string;
  /** Binary dependencies declared by this subfeature */
  dependencies: InstalledIntegrationDependencyReference[];
  /** Resources installed for this subfeature */
  resources?: InstalledIntegrationResource[];
  /** Operations applied for this subfeature */
  operations?: InstalledIntegrationOperation[];
}

/**
 * Installed declarative integration feature.
 */
export interface InstalledIntegrationFeature {
  /** Feature identifier from the integration declaration */
  featureId: string;
  /** Installation scope */
  scope: IntegrationScope;
  /** Root path associated with this feature installation target */
  targetRoot: string;
  /** CLI version that first installed the feature */
  installedByCliVersion: string;
  /** ISO timestamp when the feature was first installed */
  installedAt: string;
  /** CLI version that last updated the feature */
  updatedByCliVersion: string;
  /** ISO timestamp of the last update */
  updatedAt: string;
  /** Shared dependencies required by this feature */
  dependencies: InstalledIntegrationDependencyReference[];
  /** Resources installed for this feature */
  resources: InstalledIntegrationResource[];
  /** Operations applied for this feature */
  operations: InstalledIntegrationOperation[];
  /** Optional command-specific metadata */
  attrs?: Record<string, IntegrationStateAttribute>;
  /** Active subfeatures nested inside this container feature, if any */
  subfeatures?: InstalledSubfeature[];
}

/**
 * Installed declarative integration container.
 */
export interface InstalledIntegration {
  /** Stable state entry id */
  id: string;
  /** Integration identifier, e.g. git, claude-code, copilot-cli */
  integrationId: string;
  /** CLI version that first installed the integration */
  installedByCliVersion: string;
  /** ISO timestamp when the integration was first installed */
  installedAt: string;
  /** CLI version that last updated the integration */
  updatedByCliVersion: string;
  /** ISO timestamp of the last update */
  updatedAt: string;
  /** Features installed for this integration */
  features: InstalledIntegrationFeature[];
}

/**
 * Registry of declarative integrations installed by the CLI.
 */
export interface IntegrationsState {
  /** Installed declarative integrations */
  installed: InstalledIntegration[];
}

/**
 * Product code sent on telemetry events: SonarQube Cloud or SonarQube Server.
 * Distinct from {@link ServerType} (`cloud` / `on-premise`), which the CLI uses for auth routing.
 */
export type TelemetryConnectionType = 'sqc' | 'sqs' | null;

/** Shared identity fields on every telemetry event. */
export interface TelemetryEventIdentityPayload {
  cli_installation_id: string;
  machine_id: string;
  cli_version: string;
  invocation_id: string;
  os: string;
  connection_type: TelemetryConnectionType;
  user_uuid: string | null;
  organization_uuid_v4: string | null;
  sqs_installation_id: string | null;
  caller_agent: CallerAgent | null;
  /** Opaque agent conversation/session id when known; null when unknown (omitted on flush). */
  agent_session_id: string | null;
}

export type AnalysisTelemetryAnalyzer = 'sonar-secrets' | 'sqaa' | 'sca-scanner-cli';

/**
 * Payload for a CliAnalysisCompleted event — one event per analyzer run.
 */
export interface AnalysisCompletedEventPayload extends TelemetryEventIdentityPayload {
  /** Literal CLI subcommand path (e.g. "analyze agentic", "hook git-pre-commit") */
  caller_command: string;
  analyzer: AnalysisTelemetryAnalyzer;
  /** Per-run UUID; foreign key for a future per-finding child event. */
  analysis_id: string;
  findings_count: number;
  /**
   * Per-analyzer outcome exit code, not the combined command's final `process.exitCode`
   * when multiple analyzers run (e.g. bare `analyze` may emit secrets exit 51 and sqaa exit 0).
   *
   * sonar-secrets: spawn exit (0 clean, 51 findings, null when the scan failed to run).
   * SQAA CLI paths: 0 / 51 / 1 from issue and failure counts. SQAA PostToolUse hooks: always 0.
   */
  exit_code: number | null;
  /**
   * Analyzer-reported errors during the run (not transport failures). SQAA:
   * {@link RunTally.totalErrors} — API `errors[]` on successfully analyzed files.
   * sonar-secrets: parsed `errors[]` from `--json` output.
   */
  errors_count: number;
  /**
   * Files that could not be analyzed (SQAA: {@link RunTally.totalFailures} — HTTP errors,
   * read failures, validation rejections; counted per file, so one batch error may increment
   * multiple times). Other analyzers: 0 unless applicable.
   */
  failures_count: number;
  scan_duration_ms: number;
  /**
   * JSON-encoded, analyzer-specific allowlist blob (rule keys and per-rule counts only) when
   * `findings_count > 0`; empty string otherwise. Always a flat JSON-encoded string, never a
   * nested object — the ingestion endpoint requires flat event payloads. Empty string (not
   * `null`) so the field survives the `flushTelemetryEvents` replacer, which strips `null` values.
   */
  details: string;
}

interface TelemetryEventMetadataBase {
  event_id: string;
  source: { domain: 'CLI' };
  /** Epoch milliseconds as a string */
  event_timestamp: string;
}

/** Full CliAnalysisCompleted event written to telemetry-events.ndjson. */
export interface StoredAnalysisCompletedEvent {
  metadata: TelemetryEventMetadataBase & {
    event_type: 'Analytics.Cli.CliAnalysisCompleted';
  };
  event_payload: AnalysisCompletedEventPayload;
}

/**
 * Payload for a CliIntegrationConfigured event.
 * One event per successful `sonar integrate` run.
 */
export interface IntegrationConfiguredEventPayload extends TelemetryEventIdentityPayload {
  /** Integration id, e.g. "claude", "codex", "git". */
  integration_id: string;
  /**
   * SHA-256 hex (full 64 chars) of the canonical repo root path. Null when the
   * run is `--global` or not inside a git repository.
   */
  repo_id: string | null;
  /** Installed feature ids, including active subfeature ids. */
  features_installed: string[];
  /** Feature ids offered via an `ask` prompt that the user declined (never installed). */
  features_declined: string[];
  /** Previously-installed feature ids the user removed this run. */
  features_uninstalled: string[];
  is_global: boolean;
  is_interactive: boolean;
  /** True when invoked via the bare `sonar integrate` router, not `sonar integrate <tool>`. */
  is_from_router: boolean;
}

/** Full CliIntegrationConfigured event written to telemetry-events.ndjson. */
export interface StoredIntegrationConfiguredEvent {
  metadata: TelemetryEventMetadataBase & {
    event_type: 'Analytics.Cli.CliIntegrationConfigured';
  };
  event_payload: IntegrationConfiguredEventPayload;
}

/**
 * Payload describing a specific CLI command invocation.
 */
export interface CommandExecutedEventPayload extends TelemetryEventIdentityPayload {
  /** First-level command name (e.g. "auth" for `sonar auth login`) */
  command: string;
  /** Remainder of the command path, null when there is no subcommand */
  subcommand: string | null;
  result: 'success' | 'failure';
  /** Distribution channel of the running CLI binary. */
  distribution: Distribution;
  /**
   * SonarQube's legacy internal project identifier (`projects.uuid`, resolved via
   * `GET /api/navigation/component`) — NOT a real RFC-4122 UUID.
   *
   * The only event carrying it: `CliAnalysisCompleted` and `CliIntegrationConfigured` are
   * joined to this event on the shared `invocation_id`. Populated for every command that
   * resolves a project key (see `noteProject` in telemetry/project-uuid.ts); `null` for
   * commands that never resolve one, for `sonar integrate --global`, and when resolution
   * failed or was skipped. Stripped from the wire by the existing null-stripping replacer,
   * same as `user_uuid`/`organization_uuid_v4`.
   */
  project_uuid: string | null;
}

/** Full CliCommandExecuted event written to telemetry-events.ndjson. */
export interface StoredCommandExecutedEvent {
  metadata: TelemetryEventMetadataBase & {
    event_type: 'Analytics.Cli.CliCommandExecuted';
  };
  event_payload: CommandExecutedEventPayload;
}

/** Any event stored in telemetry-events.ndjson and drained by flushTelemetryEvents. */
export type StoredTelemetryEvent =
  StoredAnalysisCompletedEvent | StoredIntegrationConfiguredEvent | StoredCommandExecutedEvent;

/**
 * Telemetry configuration and pending event batch
 */
export interface TelemetryState {
  /** Whether telemetry collection is enabled */
  enabled: boolean;
  /** ISO timestamp of first CLI use */
  firstUseDate: string;
  /** Stable installation ID created once when state is first initialized */
  installationId?: string;
  /** Legacy CliCommandExecuted events queue. Migrated in post-update. */
  events?: StoredCommandExecutedEvent[];
}

/**
 * Complete state structure for ~/.sonar/sonarqube-cli/state.json
 */
export interface CliState {
  /** State format version */
  version: string;
  /** Last update timestamp */
  lastUpdated: string;
  /** Authentication state */
  auth: AuthState;
  /** Agent configurations */
  agents: AgentsState;
  /** CLI configuration */
  config: CliConfig;
  /** Installed tools */
  tools?: ToolsState;
  /** Shared declarative integration dependencies */
  dependencies: DependenciesState;
  /** Telemetry configuration and pending event batch */
  telemetry: TelemetryState;
  /** Registry of all agent extensions (hooks, skills) installed per project */
  agentExtensions: AgentExtension[];
  /** Registry of all declarative integrations installed per project */
  integrations: IntegrationsState;
}

/**
 * Default state structure
 */
export function getDefaultState(cliVersion: string): CliState {
  return {
    version: '1.0',
    lastUpdated: new Date().toISOString(),
    auth: {
      isAuthenticated: false,
      connections: [],
      activeConnectionId: undefined,
    },
    agents: {
      'claude-code': {
        configured: false,
        configuredAt: undefined,
        configuredByCliVersion: undefined,
        hooks: {
          installed: [],
        },
        skills: {
          installed: [],
        },
      },
    },
    config: {
      cliVersion,
    },
    tools: {
      installed: [],
    },
    dependencies: {
      installed: [],
    },
    telemetry: {
      enabled: true,
      installationId: randomUUID(),
      firstUseDate: new Date().toISOString(),
    },
    agentExtensions: [],
    integrations: {
      installed: [],
    },
  };
}
