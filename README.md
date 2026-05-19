# SonarQube CLI

**Catch code quality and security issues in your terminal—before they reach production.**

The SonarQube CLI integrates enterprise-grade static analysis into your development workflow:

- **🔒 Secret Detection** — Scan code for hardcoded credentials and prevent secrets from being sent to LLM providers
- **⚡ Fast Feedback Loop** — Get server-side issue detection on your local changes without waiting for CI/CD
- **🤖 AI-Assisted Fixes** — Generate remediation suggestions for security vulnerabilities (SonarQube Cloud)
- **🔗 Agent Integration** — Seamless hooks for Claude Code, GitHub Copilot, and other AI coding tools
- **📊 Scriptable** — Query and manage SonarQube issues programmatically with JSON output

**Use it standalone or integrate with:** Git hooks, Claude Code, GitHub Copilot, CI/CD pipelines, custom automation

> **🤖 For AI Agents:** If you are an AI agent reading this, navigate to [docs/llms.txt](https://github.com/SonarSource/sonarqube-cli/blob/master/docs/llms.txt) for machine-readable command documentation optimized for LLM consumption.

[![Build](https://github.com/SonarSource/sonarqube-cli/actions/workflows/build.yml/badge.svg?branch=master)](https://github.com/SonarSource/sonarqube-cli/actions/workflows/build.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=SonarSource_sonarqube-cli&metric=alert_status&token=4ad890bd54c6c3feb5d5251004fa3e5b1f665dea)](https://sonarcloud.io/summary/new_code?id=SonarSource_sonarqube-cli)

> **Beta Notice:** This product is currently in Beta, and we are actively collecting feedback on it. Please share your thoughts via [this form](https://forms.gle/xE61HS2E5NzxFCSR9)!

## Documentation

- **📘 Official Documentation:** [docs.sonarsource.com/sonarqube-cli](https://docs.sonarsource.com/sonarqube-cli)
- **🌐 Project Website:** [cli.sonarqube.com](https://cli.sonarqube.com/)
- **📖 Command Reference:** [cli.sonarqube.com/commands.html](https://cli.sonarqube.com/commands.html)

## Table of Contents

- [Documentation](#documentation)
- [Three Ways to Use This CLI](#three-ways-to-use-this-cli)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
  - [Step 1: Install](#step-1-install)
  - [Step 2: Authenticate](#step-2-authenticate)
  - [Step 3: Try Basic Commands](#step-3-try-basic-commands)
  - [Step 4: Analyze Local Changes](#step-4-analyze-local-changes-sonarqube-cloud-only)
- [Integrations](#integrations)
  - [Claude Code Integration](#claude-code-integration)
  - [Git Hooks](#git-hooks)
  - [GitHub Copilot Integration](#github-copilot-integration)
- [Example Outputs](#example-outputs)
- [Troubleshooting](#troubleshooting)
- [State Management](#state-management)
- [Uninstalling](#uninstalling)
- [Data Collection](#data-collection)
- [Contributing](#contributing)
- [License](#license)

## Three Ways to Use This CLI

The SonarQube CLI is designed for three distinct use cases:

1. **🤖 Agentic Use** — Built-in support for AI coding agents (Claude Code, GitHub Copilot) with pre-tool hooks that prevent secrets from being sent to LLM providers
   ```bash
   sonar integrate claude -g
   # Now Claude Code will automatically scan for secrets before processing your code
   ```

2. **🖥️ Interactive CLI** — Run commands directly in your terminal to scan code, check issues, and manage SonarQube projects manually
   ```bash
   sonar list issues --project my-app
   sonar verify --staged
   ```

3. **⚙️ Scripting & Automation** — Integrate into scripts for reporting, dashboards, or automated quality gates
   ```bash
   # Generate a report of issues across all projects:
   sonar list projects | jq -r '.projects[].key' | while read project; do
     echo "Project: $project"
     sonar list issues --project "$project" | jq -r '.issues[].severity' | sort | uniq -c
   done
   ```

## Prerequisites

Before installing, you need:

- **SonarQube Access** (choose one):
  - [SonarQube Cloud](https://sonarcloud.io) — Free for open source projects, paid for private repositories
  - SonarQube Server — Self-hosted instance (v9.9+)

- **Operating System**: Linux (x86-64, ARM64), macOS (ARM64), or Windows (x86-64)

**Optional:**
- Git 2.x+ for git hook integrations
- Claude Code or GitHub Copilot CLI for AI assistant integrations

**First time with SonarQube?** [Create a free SonarQube Cloud account](https://sonarcloud.io/sessions/new) — no credit card required for open source projects.

## Quick Start

### Step 1: Install

**Linux/macOS:**
```bash
curl -o- https://raw.githubusercontent.com/SonarSource/sonarqube-cli/refs/heads/master/user-scripts/install.sh | bash
```

**Windows (from PowerShell):**
```powershell
irm https://raw.githubusercontent.com/SonarSource/sonarqube-cli/refs/heads/master/user-scripts/install.ps1 | iex
```

**Verify installation:**
```bash
sonar --version
# Example output: 1.0.0
```

**Note:** You may need to restart your terminal for the `sonar` command to be available.

### Step 2: Authenticate

Connect to SonarQube Cloud EU (default):
```bash
sonar auth login
# Opens your browser to sign in to SonarQube and generates a user token
# Returns to terminal when complete
```

For SonarQube Cloud US:
```bash
sonar auth login --server https://sonarqube.us
```

For self-hosted SonarQube Server:
```bash
sonar auth login --server https://sonarqube.mycompany.com
```

**Verify authentication:**
```bash
sonar auth status
# Verifying token......
# [✓ Connected]
# Server  https://sonarcloud.io
# Org     my-org
# Source  OS Keychain
```

**For automation, CI/CD, and AI agents**, pass the token via environment variables. The CLI reads them at command time, so nothing is written to disk or the OS keychain, and the token does not appear in process listings (where `--with-token` would expose it via `ps aux`).

Generate a token first: SonarQube → My Account → Security → Generate Token.

Then define the following environment variables before invoking `sonar` (use your runner's secret store in CI, or your preferred local mechanism — direnv, an untracked `.env` file, a password manager CLI, etc.):

- SonarQube Cloud: `SONARQUBE_CLI_TOKEN` + `SONARQUBE_CLI_ORG`
- Self-hosted SonarQube Server: `SONARQUBE_CLI_TOKEN` + `SONARQUBE_CLI_SERVER`

With those exported, any command works without further configuration:

```bash
sonar list projects
```

Set both variables — if only `SONARQUBE_CLI_TOKEN` is present, the CLI prints a warning on stderr and falls back to keychain credentials, which is rarely what automation wants. Never commit the token or pass it as a CLI argument.

### Step 3: Try Basic Commands

**List your projects:**
```bash
sonar list projects
# {"projects":[{"key":"my-org_my-app","name":"my-app"},
#              {"key":"my-org_demo","name":"demo-project"}],
#  "paging":{"pageIndex":1,"pageSize":500,"total":2,"hasNextPage":false}}
```

Output is JSON by default. Pipe through `jq` for ad-hoc filtering, e.g. `sonar list projects | jq -r '.projects[].key'`.

**Scan a file for secrets:**
```bash
cat > test.js <<'EOF'
const STRIPE_KEY = "sk_live_<PASTE_A_REAL_STRIPE_KEY_HERE>";
EOF
sonar analyze secrets test.js
# Sonar Secrets CLI - BETA (2.43.0.11106)
# Trying to authenticate to SonarQube Server or Cloud, in order to enable complete functionality
# Authentication successful
# Running analysis...
# Found 1 secret
# Stripe API Key
# File: test.js
# Location: [1:21-1:53]
# Secret: sk_*****************************
# ❌ Secrets found (227ms)
# 💡 Remove the reported secret, then rerun the scan.
```

When a secret is found, the command exits with code `51`.

**Check issues in a project:**
```bash
sonar list issues --project my-org_my-app --format table --page-size 3
# SEVERITY | RULE             | MESSAGE                                                 | FILE
# ---------------------------------------------------------------------------------------------------------------
# CRITICAL | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity | src/preview.tsx:17
# CRITICAL | typescript:S2004 | Refactor this code to not nest functions more than 4...   | src/Preview.tsx:235
# CRITICAL | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity | src/Description.tsx:43
```

Supported formats: `json` (default), `table`, `toon`, `csv`.

> **💡 Tip:** The `--project` flag is often optional—if your working directory contains a `sonar-project.properties` file or a SonarLint connected-mode binding under `.sonarlint/`, the CLI picks the project key up from there.

### Step 4: Analyze Local Changes (SonarQube Cloud only)

```bash
cd your-project-directory
sonar verify --staged
# Analyzes uncommitted changes for new issues
# Only shows issues YOU introduced in your changes
```

**Common options:**
```bash
sonar verify --file src/myfile.ts          # Analyze a specific file
sonar verify --base main                   # Analyze changes vs main branch
sonar verify --branch feature-xyz          # Set branch context
```

---

## Integrations

### Claude Code Integration

**Global setup** (hooks apply to all Claude Code sessions):
```bash
sonar auth login
sonar integrate claude -g
```

**Project-specific setup** (hooks apply only to this project):
```bash
cd your-project
sonar auth login
sonar integrate claude --project my-org_my-project
```

This installs:
- **Pre-tool-use hook for secrets scanning** — Prevents hardcoded credentials from being sent to LLM providers
- **SonarQube Agentic Analysis integration** — Server-side code quality analysis in your workflow
- **Model Context Protocol (MCP) server** — Access SonarQube data directly from Claude Code

### Git Hooks

**Pre-commit hook** (scan staged files before each commit):
```bash
sonar integrate git --hook pre-commit
```

**Pre-push hook** (scan committed files before each push):
```bash
sonar integrate git --hook pre-push
```

**Global git hooks** (apply to all repositories):
```bash
sonar integrate git --hook pre-commit --global
```

**For CI/CD or automation** (non-interactive mode):
```bash
sonar integrate git --hook pre-commit --non-interactive
# Skips all prompts, fails fast on errors
```

### GitHub Copilot Integration

**Global setup:**
```bash
sonar auth login
sonar integrate copilot -g
```

**Project-specific setup:**
```bash
cd your-project
sonar auth login
sonar integrate copilot --project my-org_my-project
```

This installs:
- **Pre-tool-use hook for secrets scanning** — Prevents hardcoded credentials from being sent to LLM providers
- **SonarQube Agentic Analysis integration** — Server-side code quality analysis in your workflow
- **Model Context Protocol (MCP) server** — Access SonarQube data directly from Copilot

## Example Outputs

### Scanning for Secrets

```bash
$ sonar analyze secrets src/config.ts
  sonar-secrets 2.43.0.11106 is already installed (latest)
Sonar Secrets CLI - BETA (2.43.0.11106)
Trying to authenticate to SonarQube Server or Cloud, in order to enable complete functionality
Authentication successful
Running analysis...
Found 1 secret
Stripe API Key
File: src/config.ts
Location: [5:20-5:52]
Secret: sk_*****************************
❌ Secrets found (227ms)
💡 Remove the reported secret, then rerun the scan.
```

Exit codes: `0` when no secrets are found, `51` when at least one is found.

### Listing Issues

`sonar list issues` emits JSON by default; pass `--format table` for the human-readable view shown below.

```bash
$ sonar list issues --project my-org_my-app --severities CRITICAL,BLOCKER --page-size 3 --format table
SEVERITY | RULE             | MESSAGE                                                                              | FILE
-------------------------------------------------------------------------------------------------------------------------
CRITICAL | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 26 to the 15 allowed. | code/addons/a11y/src/preview.tsx:17
CRITICAL | typescript:S2004 | Refactor this code to not nest functions more than 4 levels deep.                    | code/addons/docs/src/blocks/components/Preview.tsx:235
CRITICAL | typescript:S3776 | Refactor this function to reduce its Cognitive Complexity from 23 to the 15 allowed. | code/addons/vitest/src/components/Description.tsx:43
```

### Analyzing Local Changes

```bash
$ sonar verify --staged
SonarQube Agentic Analysis: no files in the change set to analyze.
```

When there are staged changes against a project configured for SonarQube Cloud Agentic Analysis, the analyzer reports new issues introduced by the change set in the same `text`/`json` format selectable via `--format`.

### LLM-Optimized Output Format

For AI coding assistants, use `--format toon` — a token-efficient, YAML-flavored encoding of the same JSON payload:

```bash
$ sonar list issues --project my-org_my-app --severities BLOCKER --page-size 1 --format toon
total: 88
p: 1
ps: 1
paging:
  pageIndex: 1
  pageSize: 1
  total: 88
issues[1]:
  - key: AZ0avojpNWh-T1cKsujg
    rule: "typescript:S3516"
    severity: BLOCKER
    component: "my-org_my-app:src/ConfigFile.ts"
    project: my-org_my-app
    line: 377
    message: "Refactor this function to not always return the same value."
    type: CODE_SMELL
```

This format is designed for parsing by LLMs and can be used with Claude Code, GitHub Copilot, or custom AI workflows.

## Troubleshooting

### "Project key not found"

**Symptom:** `Error: Project 'my-project' not found`

**Cause:** Using the project display name instead of the project key.

**Solution:** Use the exact project key from the JSON output of `sonar list projects`:
```bash
# Find the correct key:
sonar list projects -q my-project
# {"projects":[{"key":"my-org_my-project","name":"my-project"}],
#  "paging":{"pageIndex":1,"pageSize":500,"total":1,"hasNextPage":false}}

# Or, for just the keys:
sonar list projects -q my-project | jq -r '.projects[].key'

# Use the key value (not the name) for subsequent commands:
sonar list issues --project my-org_my-project
```

---

### "No issues found" but issues exist in SonarQube web UI

**Cause:** Project hasn't been scanned yet, or you're checking the wrong branch.

**Solution:**
1. Verify your project has at least one completed scan in SonarQube
2. Check you're authenticated to the right organization:
   ```bash
   sonar auth status
   ```
3. For branch-specific issues, specify the branch:
   ```bash
   sonar list issues --project my-org_my-app --branch feature-xyz
   ```

---

### "Authentication failed" or token errors

**Symptom:** `Error: Invalid token` or browser authentication fails

**Solution:** Use token-based authentication instead:

1. Go to SonarQube → My Account → Security → Generate Token
2. Copy the generated token
3. Run:
   ```bash
   sonar auth login --with-token YOUR_TOKEN
   ```

For SonarQube Cloud, ensure you're using the correct region:
- EU (default): `--server https://sonarcloud.io`
- US: `--server https://sonarqube.us`

---

### `sonar verify` says "Not a git repository"

**Cause:** `sonar verify` requires git to detect changes.

**Solution:**
- Run from inside a git repository:
  ```bash
  cd your-project
  sonar verify
  ```
- Or analyze a specific file instead:
  ```bash
  sonar verify --file src/myfile.ts
  ```

---

### Git hook doesn't run after installation

**Symptom:** Installed pre-commit hook but it doesn't execute on `git commit`

**Solution:**

1. Check the hook file exists and is executable:
   ```bash
   ls -la .git/hooks/pre-commit
   chmod +x .git/hooks/pre-commit
   ```

2. Test the hook manually:
   ```bash
   .git/hooks/pre-commit
   ```

3. For global hooks, verify git configuration:
   ```bash
   git config --global core.hooksPath
   # Should show: ~/.sonar/git-hooks (or similar)
   ```

---

### "Command not found: sonar" after installation

**Symptom:** After running the installer, terminal doesn't recognize `sonar`

**Solution:**

1. **Restart your terminal** (required to reload PATH)

2. If still not working, manually add to PATH:

   **Linux/macOS** — Add to `~/.bashrc` or `~/.zshrc`:
   ```bash
   export PATH="$HOME/.local/share/sonarqube-cli/bin:$PATH"
   ```
   Then reload: `source ~/.bashrc` (or `~/.zshrc`)

   **Windows** — The installer should have updated PATH automatically. Try:
   - Opening a new PowerShell window
   - Restarting your computer if the issue persists

3. Verify the binary exists:
   ```bash
   # Linux/macOS:
   ls -la ~/.local/share/sonarqube-cli/bin/sonar

   # Windows (PowerShell):
   ls $env:LOCALAPPDATA\sonarqube-cli\bin\sonar.exe
   ```

---

### Secrets scanning shows false positives

**Symptom:** `sonar analyze secrets` flags test data or example code

**Solution:**

Secrets scanning is intentionally sensitive to avoid missing real credentials. For test files:

1. **Use obviously fake values:**
   ```javascript
   // ✅ Won't be flagged:
   const API_KEY = "test_fake_key_for_unit_tests";
   const TOKEN = "dummy-token-12345";

   // ❌ Might be flagged:
   const API_KEY = "sk_live_abc123xyz789";
   ```

2. **Store test secrets in ignored files:**
   - `.env.test` files are often excluded by default
   - Keep real-looking test data in fixture files outside `src/`

3. **For legitimate exceptions:** Consider adding comments explaining why the value is safe, or use environment variables even in tests.

---

### Still having issues?

- **Search existing issues:** [GitHub Issues](https://github.com/SonarSource/sonarqube-cli/issues)
- **Open a new issue:** [New Issue](https://github.com/SonarSource/sonarqube-cli/issues/new)

Include in your report:
- Output of `sonar --version`
- Full error message (with sensitive info redacted)
- Command you ran
- Operating system and version
- For authentication issues: Server URL (SonarQube Cloud vs Server)

## State Management

See [State Management](./docs/state-management.md) for more information.

## Uninstalling

### Linux/Mac OS

1. Delete the `~/.local/share/sonarqube-cli/` folder.
2. Remove `export PATH="$HOME/.local/share/sonarqube-cli/bin:$PATH"` from your `~/.bashrc` or `~/.zshrc` files.

### Windows

1. Delete the `%localappdata%\sonarqube-cli\` folder.
2. Remove this folder from the `PATH` user-level environment variable.

## Data collection

The SonarQube CLI collects anonymous usage data and error reports to help improve the product.

**Telemetry:** Anonymous command usage statistics are sent to SonarSource.

**Error reporting:** Unhandled exceptions are reported to [Sentry](https://sentry.io) to help us identify and fix crashes.

Both are enabled by default and share the same opt-out toggle. To disable all data collection:

```bash
sonar config telemetry --disabled
```

No personally identifiable information is transmitted.

## Contributing

Please be aware that we are not actively looking for feature contributions. The truth is that it's extremely difficult for someone outside
SonarSource to comply with our roadmap and expectations. Therefore, we typically only accept minor cosmetic changes and typo fixes.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup instructions, coding guidelines, and how to run tests.

## License

Copyright SonarSource Sàrl.

SonarQube CLI is released under the [GNU Lesser General Public License, Version 3.0⁠,](http://www.gnu.org/licenses/lgpl.txt).
