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
 * State management types for sonarqube-cli
 * Manages persistent state in ~/.sonarqube-cli/state.json
 */

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
export type HookType = 'PreToolUse' | 'PostToolUse' | 'SessionStart';

/**
 * Single authentication connection
 */
export interface AuthConnection {
  /** Unique identifier hash based on serverUrl and orgKey */
  id: string;
  /** Server type: SonarCloud or on-premise instance */
  type: ServerType;
  /** Server URL */
  serverUrl: string;
  /** Cloud region (only for cloud type) */
  region?: CloudRegion;
  /** Organization key (only for cloud type) */
  orgKey?: string;
  /** Timestamp when authenticated */
  authenticatedAt: string;
  /** Key for storing token in keychain */
  keystoreKey: string;
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
 * Installed hook metadata
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
 * Installed skill metadata
 */
export interface InstalledSkill {
  /** Skill name/identifier */
  name: string;
  /** Timestamp when installed */
  installedAt: string;
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
 * Complete state structure for ~/.sonarqube-cli/state.json
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
  };
}
