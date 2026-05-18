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

import type { CallerAgent } from './agent-detector.js';

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
export type HookType = 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'UserPromptSubmit';

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
   * the server side via `/api/user_tokens/revoke`. Absent when the user
   * authenticated with a manually-provided token (`--with-token`).
   */
  tokenName?: string;
  /** Timestamp when authenticated */
  authenticatedAt: string;
  /** UUID of the user on the server side (fetched at auth time) */
  userUuid?: string | null;
  /** UUID of the SonarQube Cloud organization (fetched at auth time, SQC only) */
  organizationUuidV4?: string | null;
  /** Installation ID of the SonarQube Server (fetched at auth time, SQS only) */
  sqsInstallationId?: string | null;
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

export function agentExtensionEquals(a: AgentExtension, b: AgentExtension): boolean {
  if (a.agentId !== b.agentId || a.projectRoot !== b.projectRoot) return false;
  if (a.kind !== b.kind || a.name !== b.name) return false;
  if (a.kind === 'hook' && b.kind === 'hook') return a.hookType === b.hookType;
  return true;
}

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
 * CLI configuration
 */
export interface CliConfig {
  /** Current CLI version */
  cliVersion: string;
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
  /** Resources installed for this feature */
  resources: InstalledIntegrationResource[];
  /** Operations applied for this feature */
  operations: InstalledIntegrationOperation[];
  /** Optional command-specific metadata */
  attrs?: Record<string, IntegrationStateAttribute>;
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
 * Metadata envelope for a telemetry event.
 */
export interface TelemetryEventMetadata {
  event_id: string;
  source: {
    domain: 'CLI';
  };
  event_type: 'Analytics.Cli.CliCommandExecuted';
  /** Epoch milliseconds as a string */
  event_timestamp: string;
}

/**
 * The payload describing the specific CLI command invocation.
 */
export interface TelemetryEventPayload {
  cli_installation_id: string;
  machine_id: string;
  cli_version: string;
  /** First-level command name (e.g. "auth" for `sonar auth login`) */
  command: string;
  /** Remainder of the command path, null when there is no subcommand */
  subcommand: string | null;
  invocation_id: string;
  result: 'success' | 'failure';
  os: string;
  /** "sqc" for SonarQube Cloud, "sqs" for SonarQube Server, null when not authenticated */
  connection_type: 'sqc' | 'sqs' | null;
  /** UUID of the user on SonarQube Cloud or Server, null when not authenticated or on older SQS versions */
  user_uuid: string | null;
  /** UUID of the SonarQube Cloud organization, null when not authenticated or SQS */
  organization_uuid_v4: string | null;
  /** Installation ID of the SonarQube Server, null when not authenticated or SQC */
  sqs_installation_id: string | null;
  /** Inferred caller (Cursor, Claude Code, or Copilot CLI) from the process environment. See `detectCallerAgent`. */
  caller_agent: CallerAgent | null;
}

/**
 * Full telemetry event stored in state and sent to the backend.
 */
export interface StoredTelemetryEvent {
  metadata: TelemetryEventMetadata;
  event_payload: TelemetryEventPayload;
}

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
  /** Pending events not yet sent to the backend */
  events: StoredTelemetryEvent[];
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
    telemetry: {
      enabled: true,
      installationId: randomUUID(),
      firstUseDate: new Date().toISOString(),
      events: [],
    },
    agentExtensions: [],
    integrations: {
      installed: [],
    },
  };
}
