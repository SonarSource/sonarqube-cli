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
   sonar list projects | while read project; do
     echo "Project: $project"
     sonar list issues --project $project --format json | jq '.[] | .severity' | sort | uniq -c
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
# Expected output: 0.12.0 (or newer)
```

**Note:** You may need to restart your terminal for the `sonar` command to be available.

### Step 2: Authenticate

Connect to SonarQube Cloud EU (default):
```bash
sonar auth login
# Opens your browser to authenticate via OAuth
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
# Shows: ✓ Authenticated as yourname@example.com
```

**For automation, CI/CD, and AI agents** (use token-based auth instead):
```bash
sonar auth login --with-token YOUR_TOKEN
```

Generate a token: SonarQube → My Account → Security → Generate Token

### Step 3: Try Basic Commands

**List your projects:**
```bash
sonar list projects
# Output example:
# my-app (my-org_my-app)
# demo-project (my-org_demo)
```

**Scan a file for secrets:**
```bash
echo 'const API_KEY = "sk_live_abc123"' > test.js
sonar analyze secrets test.js
# Output: ❌ Found 1 secret in test.js
```

**Check issues in a project:**
```bash
sonar list issues --project my-org_my-app
# Shows open issues from your latest SonarQube scan
```

> **💡 Tip:** When running from a git repository linked to a SonarQube project, the `--project` flag is often optional—the CLI will auto-detect the project key from your repository configuration.

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

Scanning 1 file...
❌ Found 2 secrets in src/config.ts:

  Line 12: Hardcoded API key detected
    const API_KEY = "sk_live_abc123...";

  Line 23: AWS access key detected
    const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

Exit code: 1
```

### Listing Issues

```bash
$ sonar list issues --project my-org_my-app --severities CRITICAL,BLOCKER

Found 3 issues:

🔴 BLOCKER • squid:S2068 • src/auth.js:12
   Credentials should not be hard-coded

🔴 CRITICAL • javascript:S3776 • src/utils.js:45
   Cognitive Complexity too high (25, max: 15)

🟠 CRITICAL • squid:S5042 • src/server.js:8
   Server domains should be verified during SSL/TLS connections
```

### Analyzing Local Changes

```bash
$ sonar verify --staged

Analyzing 3 staged files...
✓ Analysis complete in 2.1s

Found 1 new issue:

🟡 MAJOR • typescript:S1481 • src/helpers.ts:15
   Unused local variable 'temp'

💡 Fix this before committing
```

### AI-Assisted Remediation (SonarQube Cloud)

```bash
$ sonar remediate --project my-org_my-app

Select issue to remediate:
  ❯ 🔴 SQL injection vulnerability (src/db.ts:42)
    🟠 Hardcoded credential (src/config.ts:12)
    🟡 Unused variable (src/utils.ts:88)

Generating remediation...

[AI-generated fix displayed here]

Apply this fix? (y/n):
```

### LLM-Optimized Output Format

For AI coding assistants, use `--format toon`:

```bash
$ sonar list issues --project my-org_my-app --format toon

[ISSUE]
key: AXx1z2
rule: squid:S2068
severity: BLOCKER
message: Credentials should not be hard-coded
file: src/auth.js
line: 12
[/ISSUE]

[ISSUE]
key: BYy2a3
rule: javascript:S3776
severity: CRITICAL
message: Cognitive Complexity too high
file: src/utils.js
line: 45
[/ISSUE]
```

This format is designed for parsing by LLMs and can be used with Claude Code, GitHub Copilot, or custom AI workflows.

## Troubleshooting

### "Project key not found"

**Symptom:** `Error: Project 'my-project' not found`

**Cause:** Using the project display name instead of the project key.

**Solution:** Use the exact project key (shown in parentheses):
```bash
# Find the correct key:
sonar list projects -q my-project
# Output: my-project (key: my-org_my-project)

# Use the key in parentheses:
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
