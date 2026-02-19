# SonarQube CLI

Command-line tool for SonarQube/SonarCloud integration with Claude Code. Manages authentication tokens and retrieves code quality issues from SonarQube servers.

## Features

- **Authentication**: Securely manage SonarQube/SonarCloud tokens using system keychain
- **Issue Search**: Query and display SonarQube issues with multiple output formats
  - Formats: JSON, Table, CSV, TOON (optimized for AI agents)
  - Filter by severity, branch, pull request, and more
  - Pagination support for large result sets
- **Claude Code Integration**: Setup SonarQube hooks and configuration for Claude Code IDE
  - Automatic hook installation in `.claude/` directory
  - Configuration discovery and validation
  - Health checks and repair utilities

## Installation

#### Prerequisites

- Node.js >= 18.0.0
- **Bun**: (optional, but required for binary compilation and the quick install path that runs `npm run build:binary`)
- **npm**: Included with Node.js
- Git

### Quick Install

The easiest way to install the Sonar CLI globally on your system:

#### macOS / Linux

```bash
# Run the setup script
bash scripts/setup.sh

# Or use npm
npm run setup
```

#### Windows (PowerShell)

```powershell
# Run the setup script
powershell -ExecutionPolicy RemoteSigned -File scripts/setup.ps1
```

**What the installation does:**

1. Installs dependencies via `npm install`
2. Builds the binary into a standalone executable
3. Adds the binary to your PATH so you can run `sonar` from anywhere
   - macOS/Linux: Installs to `/usr/local/bin/sonar`
   - Windows: Installs to `%LOCALAPPDATA%\Programs\sonarqube-cli\sonar.exe`

**Verify installation:**

```bash
sonar --version
sonar --help
```

**Uninstall:**

```bash
# macOS/Linux
sudo rm /usr/local/bin/sonar

# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Programs\sonarqube-cli"
```

#### Manual Setup

1. Install dependencies:
```bash
# Using Bun (recommended)
bun install

# Or using npm
npm install
```

2. Build the TypeScript:
```bash
npm run build
```

3. Build the binary (optional):
```bash
npm run build:binary
```
This creates a standalone executable at `dist/sonarqube-cli`.

4. Install globally (optional, for development):
```bash
npm install -g .
# Now use: sonar --version
```

## Usage

### Authentication

**Login to SonarCloud (interactive):**
```bash
sonar auth login
# Opens browser for OAuth, automatically detects organization
```

**Login with specific organization:**
```bash
sonar auth login -o my-org
```

**Login to custom SonarQube server:**
```bash
sonar auth login -s https://my-sonarqube.io
```

**Non-interactive login with token:**
```bash
sonar auth login -o my-org -t your-token-here
```

**Logout:**
```bash
sonar auth logout -o my-org
sonar auth logout -s https://my-sonarqube.io
```

**Clear all tokens:**
```bash
sonar auth purge
```

### Pre-commit Hooks

**Install Sonar secrets pre-commit hook:**
```bash
sonar pre-commit install
```

This command will:
1. Install `pre-commit` CLI tool (tries brew first on macOS, falls back to pip if brew is not available; uses pip on Linux/Windows)
2. Create `.pre-commit-config.yaml` with Sonar secrets detection hook
3. Run `pre-commit autoupdate` to get the latest hook versions
4. Configure the hook to run on every git commit to detect hardcoded secrets

The hook will automatically scan your code for secrets before each commit, preventing accidental credential leaks.

**Uninstall Sonar secrets pre-commit hook:**
```bash
sonar pre-commit uninstall
```

This command will:
1. Run `pre-commit uninstall` to remove the git hooks
2. Delete the `.pre-commit-config.yaml` configuration file

### Managing sonar-secrets Binary

Install the standalone `sonar-secrets` binary from GitHub releases:

```bash
sonar secret install
```

The binary will be downloaded and installed to `~/.sonarqube-cli/bin/`.

**Check installation status:**

```bash
sonar secret status
```

**Force reinstall:**

```bash
sonar secret install --force
```

The binary will be automatically used by Claude Code hooks when configured. For manual usage:

```bash
~/.sonarqube-cli/bin/sonar-secrets scan <file>
```

### Issues Management

**Search for issues:**
```bash
sonar issues search \
  -s https://sonarcloud.io \
  -p my-project
```

**Filter by severity:**
```bash
sonar issues search \
  -s https://sonarcloud.io \
  -p my-project \
  --severity CRITICAL
```

**Output formats:**
```bash
# JSON (default)
sonar issues search -s https://sonarcloud.io -p my-project --format json

# TOON (optimized for AI agents)
sonar issues search -s https://sonarcloud.io -p my-project --format toon

# Table
sonar issues search -s https://sonarcloud.io -p my-project --format table

# CSV
sonar issues search -s https://sonarcloud.io -p my-project --format csv
```

### Claude Code Integration

**Setup integration for Claude Code:**
```bash
sonar onboard-agent claude -s https://sonarcloud.io -p my-project
```

**Interactive setup:**
```bash
sonar onboard-agent claude
# Follows interactive prompts for configuration
```

**Non-interactive setup:**
```bash
sonar onboard-agent claude \
  -s https://sonarcloud.io \
  -p my-project \
  -t your-token \
  --non-interactive
```

**Skip hooks installation:**
```bash
sonar onboard-agent claude --skip-hooks
```

## Development

### Build

#### TypeScript Compilation

Compile TypeScript to JavaScript:

```bash
npm run build
```

Output: `dist/src/` directory with compiled JavaScript files.

#### Binary Build with Bun

Build a standalone executable binary using Bun:

```bash
npm run build:binary
```

Output: `dist/sonarqube-cli` (standalone executable, ~57MB)

This creates a self-contained binary that doesn't require Node.js to run. The binary is automatically linked in `package.json` as the CLI entry point.

**Usage:**
```bash
# Direct binary execution
./dist/sonarqube-cli --version

# Via npm (uses package.json bin entry)
npm install -g .
sonar --version
```

**Requirements:**
- Bun runtime installed (`bun install`)
- For faster binary builds, Bun is recommended over npm

### Testing

```bash
# Run all tests
npm run test:all

# Run unit tests only
npm run test

# Run integration tests only
npm run test:integration

# Run specific test file
bun test tests/unit/auth.test.ts
```

### Code Generation

```bash
# Generate all commands and documentation
npm run gen:all

# Generate a new command
npm run gen:command

# Sync index.ts from CLI spec
npm run gen:sync

# Generate documentation
npm run gen:docs
```

### Validation

```bash
# Validate CLI specification
npm run spec:validate

# Validate all commands
npm run commands:validate

# Full validation
npm run validate
```

### Type Checking

```bash
npm run typecheck
```

## Project Structure

```
src/
├── commands/              # CLI command implementations
│   ├── auth.ts           # Authentication (login, logout, purge)
│   ├── issues.ts         # Issue search and display
│   ├── onboard-agent.ts  # Claude Code integration setup
│   └── pre-commit.ts     # Pre-commit hooks for secrets detection
├── bootstrap/            # Initialization and setup modules
│   ├── auth.ts           # OAuth and token management
│   ├── hooks.ts          # Claude Code hooks installation
│   ├── mcp.ts            # Model Context Protocol setup
│   ├── discovery.ts      # Project configuration discovery
│   ├── health.ts         # Health checks
│   └── repair.ts         # Configuration repair utilities
├── lib/                  # Utility libraries
│   ├── keychain.ts       # Secure token storage (macOS keychain)
│   ├── browser.ts        # Browser automation for OAuth
│   ├── process.ts        # Process management utilities
│   └── types.ts          # TypeScript types
├── sonarqube/            # SonarQube API client
│   ├── client.ts         # HTTP API client
│   └── issues.ts         # Issue search and formatting
├── formatter/            # Output formatters
│   ├── json.ts           # JSON formatter
│   ├── table.ts          # Table formatter
│   ├── csv.ts            # CSV formatter
│   └── toon.ts           # TOON formatter (for AI agents)
└── index.ts              # CLI entry point

tests/
├── unit/                 # Unit tests
├── integration/          # Integration tests
```

## Configuration

### Token Storage

Tokens are securely stored in the system keychain:

- **SonarCloud**: Key format is `sonarcloud.io:organization-key`
- **SonarQube**: Key format is `server-hostname`

Example:
```bash
# SonarCloud token for "my-org"
Service: sonarqube-cli
Account: sonarcloud.io:my-org
Password: your-token

# SonarQube token for custom server
Service: sonarqube-cli
Account: my-sonarqube.io
Password: your-token
```

### Project Configuration

Configuration can be read from:
- `sonar-project.properties` (Maven/Gradle projects)
- `.sonarlint/connectedMode.json` (SonarLint configuration)

## Commands Reference

```
sonar [options] [command]

Commands:
  auth [command]           Manage authentication tokens (login, logout, purge)
  issues search [options]  Search for issues in SonarQube
  onboard-agent [options]  Setup Claude Code integration
  pre-commit [command]     Manage pre-commit hooks for secrets detection

Options:
  -V, --version           Output version number
  -h, --help              Display help for command
```

## Environment Variables

- `SONARQUBE_URL`: Default SonarQube server URL
- `SONARQUBE_TOKEN`: Authentication token
- `SONARQUBE_ORG`: SonarCloud organization key

## Troubleshooting

### Token Issues

**Problem**: "403 Unauthorized" errors when using SonarCloud

**Solution**: Verify you've selected the correct organization during `sonar auth login`. If wrong organization was selected, logout and login again:
```bash
sonar auth logout -o wrong-org
sonar auth login
```

### Browser Not Opening

**Problem**: Browser doesn't open automatically during `sonar auth login`

**Solution**: Copy the URL shown in terminal and open it manually in your browser

### Build Errors

**Problem**: TypeScript compilation errors

**Solution**: Ensure Node.js version is >= 18.0.0:
```bash
node --version
```

## Contributing

1. Clone the repository
2. Install dependencies: `npm install` or `bun install`
3. Create a feature branch: `git checkout -b feature/my-feature`
4. Make changes and add tests
5. Run tests: `npm run test:all`
6. Run validation: `npm run validate`
7. Commit changes: `git commit -m "feat: add my-feature"`
8. Push to remote: `git push origin feature/my-feature`
9. Open a pull request

## License

Proprietary - Sonar

## Support

For issues and questions:
- Check existing GitHub issues
- Create a new issue with detailed description
- Include output from `npm run test:all`
- Provide steps to reproduce the problem
