# State Management

The SonarQube CLI maintains persistent state in `~/.sonar/sonarqube-cli/state.json`. This document explains the state file structure, its fields, and provides examples for different scenarios.

## Overview

The state file persists configuration across CLI invocations and stores:

- **Authentication**: Server connections details. Tokens are stored securely in system keychain, NOT in the state file
- **Legacy Agent Configuration**: Backward-compatible agent status plus legacy hook and skill lists
- **Agent Extension Registry**: Per-project/global hooks, skills, and instruction files installed for agents
- **Declarative Integrations**: Generic records of installed integrations, features, resources, and operations
- **Tool Metadata**: Installed external tools like sonar-secrets binary
- **Telemetry Data**: Anonymous usage statistics and pending telemetry events

## Location

```
~/.sonar/sonarqube-cli/state.json
```

## State Structure

### Root Level

| Field             | Type                  | Description                                         |
| ----------------- | --------------------- | --------------------------------------------------- |
| `version`         | string                | State format version (currently `"1.0"`)            |
| `lastUpdated`     | ISO 8601 timestamp    | When state was last modified                        |
| `auth`            | AuthState             | Authentication and server connections               |
| `agents`          | AgentsState           | Configuration for each agent (Claude Code, etc.)    |
| `config`          | CliConfig             | CLI configuration metadata                          |
| `tools`           | ToolsState (optional) | Installed tools and binaries                        |
| `telemetry`       | TelemetryState        | Telemetry configuration and pending events          |
| `agentExtensions` | AgentExtension[]      | Installed agent extensions per project/global scope |
| `integrations`    | IntegrationsState     | Generic declarative integration install records     |

### Auth Section

| Field                | Type              | Description                                  |
| -------------------- | ----------------- | -------------------------------------------- |
| `isAuthenticated`    | boolean           | Whether at least one valid connection exists |
| `connections`        | AuthConnection[]  | List of configured server connections        |
| `activeConnectionId` | string (optional) | ID of the currently active connection        |

#### AuthConnection Fields

| Field             | Type                    | Required | Description                                 |
| ----------------- | ----------------------- | -------- | ------------------------------------------- |
| `id`              | string                  | ✅       | Hash identifier (from serverUrl + orgKey)   |
| `type`            | 'cloud' \| 'on-premise' | ✅       | Server type classification                  |
| `serverUrl`       | string                  | ✅       | Server URL (e.g., `https://sonarcloud.io`)  |
| `orgKey`          | string                  | ❌\*     | Organization key (for SonarQube Cloud only) |
| `region`          | 'eu' \| 'us'            | ❌\*     | Cloud region (for SonarQube Cloud only)     |
| `authenticatedAt` | ISO 8601 timestamp      | ✅       | When connection was established             |

\*Required only for SonarQube Cloud connections

### Agents Section

The `agents` section is kept for compatibility with existing agent-specific setup flows. Newer integrations may also write to `agentExtensions` and `integrations`.

| Field            | Type        | Description                     |
| ---------------- | ----------- | ------------------------------- |
| `claude-code`    | AgentConfig | Claude Code agent configuration |
| `[other-agents]` | AgentConfig | Future agents can be added      |

#### AgentConfig Fields

| Field                    | Type                          | Description                           |
| ------------------------ | ----------------------------- | ------------------------------------- |
| `configured`             | boolean                       | Whether agent is fully configured     |
| `configuredAt`           | ISO 8601 timestamp (optional) | When agent was configured             |
| `configuredByCliVersion` | string (optional)             | CLI version that configured the agent |
| `hooks.installed`        | InstalledHook[]               | List of installed hooks               |
| `skills.installed`       | InstalledSkill[]              | List of installed skills              |

#### Hook Types

- `PreToolUse`: Executes before Claude Code invokes a tool
- `PostToolUse`: Executes after Claude Code invokes a tool
- `SessionStart`: Executes when Claude Code session starts
- `UserPromptSubmit`: Executes when the user submits a prompt

### Agent Extensions Section

The `agentExtensions` registry stores per-project or global artifacts installed for an agent, such as hooks, skills, and instruction files.

| Field             | Type             | Description                |
| ----------------- | ---------------- | -------------------------- |
| `agentExtensions` | AgentExtension[] | Installed agent extensions |

#### Base Agent Extension Fields

| Field                 | Type               | Description                                            |
| --------------------- | ------------------ | ------------------------------------------------------ |
| `id`                  | string             | Stable state entry identifier                          |
| `agentId`             | string             | Agent identifier, e.g. `claude-code`                   |
| `projectRoot`         | string             | Absolute path to the associated project or global root |
| `global`              | boolean            | Whether the extension was installed globally           |
| `projectKey`          | string (optional)  | SonarQube project key associated with the extension    |
| `orgKey`              | string (optional)  | SonarQube Cloud organization key                       |
| `serverUrl`           | string (optional)  | SonarQube server URL                                   |
| `updatedByCliVersion` | string             | CLI version that last updated the extension            |
| `updatedAt`           | ISO 8601 timestamp | Last update time                                       |

#### Agent Extension Variants

- `HookExtension`: `kind: 'hook'`, plus `name` and `hookType`
- `SkillExtension`: `kind: 'skill'`, plus `name` and optional `version`
- `InstructionsExtension`: `kind: 'instructions'`, plus `name`

### Config Section

| Field        | Type   | Description             |
| ------------ | ------ | ----------------------- |
| `cliVersion` | string | Latest CLI version used |

### Tools Section

| Field       | Type            | Description              |
| ----------- | --------------- | ------------------------ |
| `installed` | InstalledTool[] | Array of installed tools |

#### InstalledTool Fields

| Field                   | Type               | Description                             |
| ----------------------- | ------------------ | --------------------------------------- |
| `name`                  | string             | Tool identifier (e.g., `sonar-secrets`) |
| `version`               | string             | Installed tool version                  |
| `path`                  | string             | Full path to tool binary                |
| `installedAt`           | ISO 8601 timestamp | Installation time                       |
| `installedByCliVersion` | string             | CLI version that installed the tool     |

### Telemetry Section

| Field            | Type                   | Description                             |
| ---------------- | ---------------------- | --------------------------------------- |
| `enabled`        | boolean                | Whether telemetry collection is enabled |
| `firstUseDate`   | ISO 8601 timestamp     | When the CLI was first used             |
| `installationId` | string (optional)      | Stable installation identifier          |
| `events`         | StoredTelemetryEvent[] | Pending telemetry events not yet sent   |

### Integrations Section

The `integrations.installed` registry is the generic state surface for declarative integrations such as Git, Claude, Copilot, and future tools. It records which integration has installed features and where each feature was installed.

| Field       | Type                   | Description                        |
| ----------- | ---------------------- | ---------------------------------- |
| `installed` | InstalledIntegration[] | Installed declarative integrations |

#### InstalledIntegration Fields

| Field                   | Type                          | Description                                      |
| ----------------------- | ----------------------------- | ------------------------------------------------ |
| `id`                    | string                        | Stable state entry identifier                    |
| `integrationId`         | string                        | Integration identifier                           |
| `installedByCliVersion` | string                        | CLI version that first installed the integration |
| `installedAt`           | ISO 8601 timestamp            | Initial installation time                        |
| `updatedByCliVersion`   | string                        | CLI version that last updated the integration    |
| `updatedAt`             | ISO 8601 timestamp            | Last update time                                 |
| `features`              | InstalledIntegrationFeature[] | Features installed for this integration          |

#### InstalledIntegrationFeature Fields

| Field                   | Type                            | Description                                   |
| ----------------------- | ------------------------------- | --------------------------------------------- |
| `featureId`             | string                          | Feature identifier from the declaration       |
| `scope`                 | `'project' \| 'global'`         | Installation scope                            |
| `targetRoot`            | string                          | Root path associated with this feature target |
| `installedByCliVersion` | string                          | CLI version that first installed the feature  |
| `installedAt`           | ISO 8601 timestamp              | Initial installation time                     |
| `updatedByCliVersion`   | string                          | CLI version that last updated the feature     |
| `updatedAt`             | ISO 8601 timestamp              | Last update time                              |
| `resources`             | InstalledIntegrationResource[]  | Resources applied for the feature             |
| `operations`            | InstalledIntegrationOperation[] | Operations applied for the feature            |
| `attrs`                 | object (optional)               | Command-specific scalar metadata              |

#### InstalledIntegrationResource Fields

| Field                 | Type               | Description                                                     |
| --------------------- | ------------------ | --------------------------------------------------------------- |
| `id`                  | string             | Resource identifier from the declaration                        |
| `resourceType`        | string             | Resource type, e.g. `whole-file`, `json-patch`, or `yaml-patch` |
| `version`             | string (optional)  | Resource declaration version                                    |
| `path`                | string (optional)  | Resolved path for resources written to disk                     |
| `updatedByCliVersion` | string             | CLI version that last updated the resource                      |
| `updatedAt`           | ISO 8601 timestamp | Last resource update time                                       |

#### InstalledIntegrationOperation Fields

| Field                 | Type               | Description                               |
| --------------------- | ------------------ | ----------------------------------------- |
| `id`                  | string             | Operation identifier from the declaration |
| `version`             | string (optional)  | Operation declaration version             |
| `updatedByCliVersion` | string             | CLI version that last ran the operation   |
| `updatedAt`           | ISO 8601 timestamp | Last operation execution time             |

---

## Examples

The examples below focus on the fields relevant to each scenario and may omit unrelated sections for brevity.

### Example 1: SonarQube Cloud with Claude Code Integration

A user authenticated with SonarQube Cloud and configured Claude Code with a PreToolUse hook.

```json
{
  "version": "1.0",
  "lastUpdated": "2026-02-18T10:30:00.000Z",
  "auth": {
    "isAuthenticated": true,
    "connections": [
      {
        "id": "abc123def456",
        "type": "cloud",
        "serverUrl": "https://sonarcloud.io",
        "orgKey": "my-organization",
        "region": "eu",
        "authenticatedAt": "2026-02-18T10:00:00.000Z"
      }
    ],
    "activeConnectionId": "abc123def456"
  },
  "agents": {
    "claude-code": {
      "configured": true,
      "configuredAt": "2026-02-18T10:15:00.000Z",
      "configuredByCliVersion": "0.2.102",
      "hooks": {
        "installed": [
          {
            "name": "sonar-verify-hook",
            "type": "PreToolUse",
            "installedAt": "2026-02-18T10:15:00.000Z"
          }
        ]
      },
      "skills": {
        "installed": []
      }
    }
  },
  "config": {
    "cliVersion": "0.2.102"
  },
  "tools": {
    "installed": []
  }
}
```

### Example 2: On-Premise SonarQube

A user authenticated with a self-hosted SonarQube instance (no organization required).

```json
{
  "version": "1.0",
  "lastUpdated": "2026-02-18T10:30:00.000Z",
  "auth": {
    "isAuthenticated": true,
    "connections": [
      {
        "id": "44a2bfab8f2c6ffa",
        "type": "on-premise",
        "serverUrl": "https://sonar.company.com:9000",
        "authenticatedAt": "2026-02-18T09:45:00.000Z"
      }
    ],
    "activeConnectionId": "44a2bfab8f2c6ffa"
  },
  "agents": {
    "claude-code": {
      "configured": false,
      "hooks": {
        "installed": []
      },
      "skills": {
        "installed": []
      }
    }
  },
  "config": {
    "cliVersion": "0.2.102"
  },
  "tools": {
    "installed": []
  }
}
```

### Example 3: Expanded Example with Hooks and Skills

A complete setup with SonarQube Cloud, multiple hooks, skills, and installed tools.

```json
{
  "version": "1.0",
  "lastUpdated": "2026-02-18T15:45:30.000Z",
  "auth": {
    "isAuthenticated": true,
    "connections": [
      {
        "id": "xyz789abc123",
        "type": "cloud",
        "serverUrl": "https://sonarcloud.io",
        "orgKey": "sonarsource",
        "region": "eu",
        "authenticatedAt": "2026-02-15T14:22:10.000Z"
      }
    ],
    "activeConnectionId": "xyz789abc123"
  },
  "agents": {
    "claude-code": {
      "configured": true,
      "configuredAt": "2026-02-18T14:10:00.000Z",
      "configuredByCliVersion": "0.2.102",
      "hooks": {
        "installed": [
          {
            "name": "sonar-verify-hook",
            "type": "PreToolUse",
            "installedAt": "2026-02-18T14:10:00.000Z"
          },
          {
            "name": "sonar-report-hook",
            "type": "PostToolUse",
            "installedAt": "2026-02-18T15:20:00.000Z"
          }
        ]
      },
      "skills": {
        "installed": [
          {
            "name": "sonar-security-checker",
            "installedAt": "2026-02-18T14:30:00.000Z"
          },
          {
            "name": "code-quality-analyzer",
            "installedAt": "2026-02-18T15:00:00.000Z"
          }
        ]
      }
    }
  },
  "config": {
    "cliVersion": "0.2.102"
  },
  "tools": {
    "installed": [
      {
        "name": "sonar-secrets",
        "version": "2.38.0.10279",
        "path": "/Users/john.doe/.sonar/sonarqube-cli/bin/sonar-secrets",
        "installedAt": "2026-02-16T11:48:27.000Z",
        "installedByCliVersion": "0.2.95"
      }
    ]
  }
}
```

---

## Common Operations

### View Current State

```bash
cat ~/.sonar/sonarqube-cli/state.json | jq .
```

### Check Authentication Status

```bash
cat ~/.sonar/sonarqube-cli/state.json | jq '.auth'
```

### View Installed Hooks

```bash
cat ~/.sonar/sonarqube-cli/state.json | jq '.agents."claude-code".hooks.installed'
```

### View Installed Tools

```bash
cat ~/.sonar/sonarqube-cli/state.json | jq '.tools.installed'
```

---

## Important Notes

### Token Storage

**Tokens are NOT stored in the state file.** They are stored securely in the OS credential store via [`Bun.secrets`](https://bun.com/docs/runtime/secrets):

- **macOS**: Keychain Services
- **Linux**: libsecret (GNOME Keyring, KWallet, etc.)
- **Windows**: Windows Credential Manager

The keychain account key is derived from the connection's `serverUrl` and `orgKey` fields.

### State Modification

The state file is managed automatically by the CLI. Direct manual editing is not recommended. Use CLI commands instead:

```bash
# Add authentication
sonar auth login -s https://sonarcloud.io -o my-org

# Configure Claude Code integration
sonar integrate claude --project my-project

# Install a Git hook integration
sonar integrate git --hook pre-commit

# Check status
sonar auth status

# Inspect or change telemetry configuration
sonar config telemetry
```

### Backward Compatibility

When the CLI is upgraded, it automatically migrates the state to the new format if needed. The `version` field indicates the state format version.

---

## Troubleshooting

### State File Not Found

If `~/.sonar/sonarqube-cli/state.json` doesn't exist, the CLI falls back to a default in-memory state and creates the file the first time it persists configuration.

### Invalid JSON

If the state file becomes corrupted:

```bash
# Backup the corrupted file
cp ~/.sonar/sonarqube-cli/state.json ~/.sonar/sonarqube-cli/state.json.backup

# Reset to a clean state (requires re-authentication)
rm ~/.sonar/sonarqube-cli/state.json
```

When the file cannot be parsed, the CLI falls back to a default in-memory state until it can write a new valid state file.

### Lost Authentication

If state entries are lost but tokens remain in the keychain:

```bash
# Inspect the active connection
sonar auth status

# Re-authenticate to recreate the missing state entries
sonar auth login -s https://sonarcloud.io -o my-org
```
