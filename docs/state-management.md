# State Management

The SonarQube CLI maintains persistent state in `~/.sonar/sonarqube-cli/state.json`. This document explains the state file structure, its fields, and provides examples for different scenarios.

## Overview

The state file persists configuration across CLI invocations and stores:
- **Authentication**: Server connections details. Tokens are stored securely in system keychain, NOT in the state file
- **Agent Configuration**: Integration status with Claude Code and other agents
- **Installed Hooks**: Pre/Post tool use and session start hooks for agent interactions
- **Installed Skills**: Custom Claude Code skills
- **Tool Metadata**: Installed external tools like sonar-secrets binary
- **Telemetry data**: Anonymous usage statistics

## Location

```
~/.sonar/sonarqube-cli/state.json
```

## State Structure

### Root Level

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | State format version (currently `"1.0"`) |
| `lastUpdated` | ISO 8601 timestamp | When state was last modified |
| `auth` | AuthState | Authentication and server connections |
| `agents` | AgentsState | Configuration for each agent (Claude Code, etc.) |
| `config` | CliConfig | CLI configuration metadata |
| `tools` | ToolsState (optional) | Installed tools and binaries |

### Auth Section

| Field | Type | Description |
|-------|------|-------------|
| `isAuthenticated` | boolean | Whether at least one valid connection exists |
| `connections` | AuthConnection[] | List of configured server connections |
| `activeConnectionId` | string (optional) | ID of the currently active connection |

#### AuthConnection Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ | Hash identifier (from serverUrl + orgKey) |
| `type` | 'cloud' \| 'on-premise' | ✅ | Server type classification |
| `serverUrl` | string | ✅ | Server URL (e.g., `https://sonarcloud.io`) |
| `orgKey` | string | ❌* | Organization key (for SonarQube Cloud only) |
| `region` | 'eu' \| 'us' | ❌* | Cloud region (for SonarQube Cloud only) |
| `authenticatedAt` | ISO 8601 timestamp | ✅ | When connection was established |
| `keystoreKey` | string | ✅ | Key for token retrieval from system keychain |

*Required only for SonarQube Cloud connections

### Agents Section

| Field | Type | Description |
|-------|------|-------------|
| `claude-code` | AgentConfig | Claude Code agent configuration |
| `[other-agents]` | AgentConfig | Future agents can be added |

#### AgentConfig Fields

| Field | Type | Description |
|-------|------|-------------|
| `configured` | boolean | Whether agent is fully configured |
| `configuredAt` | ISO 8601 timestamp (optional) | When agent was configured |
| `configuredByCliVersion` | string (optional) | CLI version that configured the agent |
| `hooks.installed` | InstalledHook[] | List of installed hooks |
| `skills.installed` | InstalledSkill[] | List of installed skills |

#### Hook Types

- `PreToolUse`: Executes before Claude Code invokes a tool
- `PostToolUse`: Executes after Claude Code invokes a tool
- `SessionStart`: Executes when Claude Code session starts

### Config Section

| Field | Type | Description |
|-------|------|-------------|
| `cliVersion` | string | Latest CLI version used |

### Tools Section

| Field | Type | Description |
|-------|------|-------------|
| `installed` | InstalledTool[] | Array of installed tools |

#### InstalledTool Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Tool identifier (e.g., `sonar-secrets`) |
| `version` | string | Installed tool version |
| `path` | string | Full path to tool binary |
| `installedAt` | ISO 8601 timestamp | Installation time |
| `installedByCliVersion` | string | CLI version that installed the tool |

---

## Examples

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
        "authenticatedAt": "2026-02-18T10:00:00.000Z",
        "keystoreKey": "abc123def456"
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
        "authenticatedAt": "2026-02-18T09:45:00.000Z",
        "keystoreKey": "44a2bfab8f2c6ffa"
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

### Example 3: Full Configuration with Hooks and Skills

A complete setup with SonarCloud, multiple hooks, skills, and installed tools.

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
        "authenticatedAt": "2026-02-15T14:22:10.000Z",
        "keystoreKey": "xyz789abc123"
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

**Tokens are NOT stored in the state file.** They are stored securely in the system keychain:
- **macOS**: Keychain
- **Linux**: Secret Service or pass
- **Windows**: Credential Manager

The `keystoreKey` field in the connection object is used to retrieve the token from the keychain.

### State Modification

The state file is managed automatically by the CLI. Direct manual editing is not recommended. Use CLI commands instead:

```bash
# Add authentication
sonar auth login -s https://sonarcloud.io -o my-org

# Configure agent
sonar onboard-agent claude

# Install hook
sonar secret install

# Check status
sonar auth status
```

### Backward Compatibility

When the CLI is upgraded, it automatically migrates the state to the new format if needed. The `version` field indicates the state format version.

---

## Troubleshooting

### State File Not Found

If `~/.sonar/sonarqube-cli/state.json` doesn't exist, it will be created automatically on first use.

### Invalid JSON

If the state file becomes corrupted:

```bash
# Backup the corrupted file
cp ~/.sonar/sonarqube-cli/state.json ~/.sonar/sonarqube-cli/state.json.backup

# Reset to default state (requires re-authentication)
rm ~/.sonar/sonarqube-cli/state.json
```

### Lost Authentication

If connections are lost but tokens remain in keychain:

```bash
# List available tokens
sonar auth status

# The tokens can be manually restored by re-authenticating
```
