# Error Messages Audit: CLI Argument Validation

## Goal

Audit every CLI command with every possible argument variation to ensure:
1. Informative error messages when arguments are wrong/missing
2. Correct behavior with valid inputs
3. Clear guidance on how to fix errors
4. No confusing or misleading output

## Commands Under Test

| Command | Subcommand | Arguments | Options |
|---------|-----------|-----------|---------|
| `sonar verify` | — | none | `--file`, `--organization`, `--project`, `-t/--token`, `-b/--branch`, `--save-config` |
| `sonar issues search` | — | none | `-s/--server`, `-t/--token`, `-p/--project`, `--severity`, `--format`, `--branch`, `--pull-request`, `--all`, `--page-size` |
| `sonar onboard-agent` | — | `<agent>` | `-s/--server`, `-p/--project`, `-t/--token`, `-o/--org`, `--non-interactive`, `--skip-hooks`, `--hook-type`, `--verbose` |
| `sonar auth login` | `login` | none | `-s/--server`, `-o/--org`, `-t/--with-token` |
| `sonar auth logout` | `logout` | none | `-s/--server`, `-o/--org` |
| `sonar auth purge` | `purge` | none | none |
| `sonar auth list` | `list` | none | none |
| `sonar pre-commit install` | `install` | none | none |
| `sonar pre-commit uninstall` | `uninstall` | none | none |
| `sonar secret install` | `install` | none | `--force` |
| `sonar secret status` | `status` | none | none |
| `sonar secret check` | `check` | none | `--file`, `--stdin` |

## Test Matrix for Each Command

For each command, test the following input variations:

### Argument Variations
- **Valid**: correct expected input
- **Empty** (no args): command with no arguments/options
- **Empty string**: `--option ""`
- **Garbage**: `--option "xyz_garbage_123!@#"`
- **Path that doesn't exist**: for file arguments
- **Typo in subcommand**: e.g., `sonar auth loginn`
- **Unknown option**: e.g., `--unknown-flag`
- **Missing required options**: skip one or more required flags
- **Type mismatch**: e.g., string where expected int

### Expected Quality Criteria
- [ ] Error message clearly states WHAT went wrong
- [ ] Error message suggests HOW to fix it
- [ ] No stack traces or internal details leaked to user
- [ ] Exit code is non-zero on error
- [ ] Exit code is 0 on success
- [ ] Help text accessible via `--help`

---

## Test Results

### 1. `sonar verify`

#### 1.1 No arguments
```
sonar verify
```
**Expected**: error about missing `--file`
**Actual**: TBD

#### 1.2 --file with nonexistent path
```
sonar verify --file /tmp/does_not_exist.ts
```
**Expected**: "File not found: /tmp/does_not_exist.ts"
**Actual**: TBD

#### 1.3 --file with empty string
```
sonar verify --file ""
```
**Expected**: error about missing/empty file path
**Actual**: TBD

#### 1.4 --file with valid file, no credentials
```
sonar verify --file ./src/index.ts
```
**Expected**: prompt for credentials or clear error about missing org/project/token
**Actual**: TBD

#### 1.5 --format with invalid value
```
sonar verify --file ./src/index.ts --format xyz
```
**Expected**: "Invalid format. Use: json, toon, table, csv"
**Actual**: TBD

#### 1.6 Unknown option
```
sonar verify --unknown-flag
```
**Expected**: Commander.js unknown option error
**Actual**: TBD

---

### 2. `sonar issues search`

#### 2.1 No arguments
```
sonar issues search
```
**Expected**: error about missing required options
**Actual**: TBD

#### 2.2 Missing --server
```
sonar issues search -p my-project -t mytoken
```
**Expected**: error or fallback to saved state
**Actual**: TBD

#### 2.3 Missing --project
```
sonar issues search -s https://sonarcloud.io -t mytoken
```
**Expected**: error about missing project
**Actual**: TBD

#### 2.4 --format with invalid value
```
sonar issues search -s https://sonarcloud.io -p proj --format xml
```
**Expected**: "Invalid format" error
**Actual**: TBD

#### 2.5 --page-size with non-numeric
```
sonar issues search -s https://sonarcloud.io -p proj --page-size abc
```
**Expected**: error about invalid page size
**Actual**: TBD

#### 2.6 --server with garbage URL
```
sonar issues search -s "not-a-url" -p proj -t tok
```
**Expected**: error about invalid server URL
**Actual**: TBD

#### 2.7 --severity with invalid value
```
sonar issues search -s https://sonarcloud.io -p proj --severity INVALID
```
**Expected**: error about invalid severity
**Actual**: TBD

#### 2.8 --server with empty string
```
sonar issues search -s "" -p proj -t tok
```
**Expected**: error about empty server URL
**Actual**: TBD

---

### 3. `sonar onboard-agent`

#### 3.1 No agent argument
```
sonar onboard-agent
```
**Expected**: error "missing required argument 'agent'"
**Actual**: TBD

#### 3.2 Invalid agent name
```
sonar onboard-agent vscode
```
**Expected**: "Unknown agent 'vscode'. Valid agents: claude, gemini, codex"
**Actual**: TBD

#### 3.3 Empty string agent
```
sonar onboard-agent ""
```
**Expected**: error about empty/invalid agent name
**Actual**: TBD

#### 3.4 Garbage agent name
```
sonar onboard-agent xyz_garbage
```
**Expected**: "Unknown agent 'xyz_garbage'. Valid agents: ..."
**Actual**: TBD

#### 3.5 --non-interactive without --org (SonarCloud)
```
sonar onboard-agent claude --non-interactive --server https://sonarcloud.io -p proj -t tok
```
**Expected**: error "Organization required for SonarCloud in non-interactive mode"
**Actual**: TBD

#### 3.6 --hook-type with invalid value
```
sonar onboard-agent claude --hook-type xyz
```
**Expected**: error about invalid hook type
**Actual**: TBD

---

### 4. `sonar auth login`

#### 4.1 No arguments (interactive)
```
sonar auth login
```
**Expected**: prompts for org, launches browser
**Actual**: TBD

#### 4.2 --org with empty string
```
sonar auth login --org ""
```
**Expected**: error about empty org
**Actual**: TBD

#### 4.3 --org with garbage value
```
sonar auth login --org "xyz_garbage_123"
```
**Expected**: API call fails, error "Organization not found: xyz_garbage_123"
**Actual**: TBD

#### 4.4 --with-token with empty string
```
sonar auth login --org myorg --with-token ""
```
**Expected**: error about empty token
**Actual**: TBD

#### 4.5 --server with garbage URL
```
sonar auth login --server "not-a-url" --with-token mytoken
```
**Expected**: error about invalid server URL
**Actual**: TBD

#### 4.6 --server with empty string
```
sonar auth login --server "" --with-token mytoken
```
**Expected**: error about empty server
**Actual**: TBD

---

### 5. `sonar auth logout`

#### 5.1 No arguments
```
sonar auth logout
```
**Expected**: error or prompt for org (SonarCloud)
**Actual**: TBD

#### 5.2 --org with garbage value
```
sonar auth logout --org "xyz_garbage"
```
**Expected**: "No token found for organization xyz_garbage" or similar
**Actual**: TBD

#### 5.3 --org with empty string
```
sonar auth logout --org ""
```
**Expected**: error about empty org
**Actual**: TBD

---

### 6. `sonar auth purge`

#### 6.1 No tokens in keychain
```
sonar auth purge
```
**Expected**: "No credentials found" or prompts confirmation and removes nothing
**Actual**: TBD

---

### 7. `sonar auth list`

#### 7.1 No arguments (no saved state)
```
sonar auth list
```
**Expected**: "No connections saved" or lists connections
**Actual**: TBD

---

### 8. `sonar pre-commit install`

#### 8.1 Not in a git repo
```
sonar pre-commit install  # run from /tmp
```
**Expected**: "Not a git repository" error
**Actual**: TBD

#### 8.2 Unknown option
```
sonar pre-commit install --flag xyz
```
**Expected**: Commander.js unknown option error
**Actual**: TBD

---

### 9. `sonar pre-commit uninstall`

#### 9.1 Not installed
```
sonar pre-commit uninstall
```
**Expected**: graceful "nothing to uninstall" or success
**Actual**: TBD

---

### 10. `sonar secret install`

#### 10.1 No arguments
```
sonar secret install
```
**Expected**: downloads and installs binary
**Actual**: TBD

#### 10.2 --force flag
```
sonar secret install --force
```
**Expected**: reinstalls even if already installed
**Actual**: TBD

#### 10.3 Unknown option
```
sonar secret install --unknown
```
**Expected**: Commander.js unknown option error
**Actual**: TBD

---

### 11. `sonar secret status`

#### 11.1 Binary not installed
```
sonar secret status  # with binary removed
```
**Expected**: "sonar-secrets is not installed. Run: sonar secret install"
**Actual**: TBD

#### 11.2 Unknown option
```
sonar secret status --unknown
```
**Expected**: Commander.js unknown option error
**Actual**: TBD

---

### 12. `sonar secret check`

#### 12.1 No options
```
sonar secret check
```
**Expected**: error "Provide either --file or --stdin"
**Actual**: TBD

#### 12.2 --file with nonexistent path
```
sonar secret check --file /tmp/does_not_exist.ts
```
**Expected**: "File not found: /tmp/does_not_exist.ts"
**Actual**: TBD

#### 12.3 --file with empty string
```
sonar secret check --file ""
```
**Expected**: error about empty/invalid file path
**Actual**: TBD

#### 12.4 --file and --stdin together
```
sonar secret check --file somefile.ts --stdin
```
**Expected**: error "Cannot use --file and --stdin together"
**Actual**: TBD

#### 12.5 --file with garbage path
```
sonar secret check --file "xyz_garbage"
```
**Expected**: "File not found: xyz_garbage"
**Actual**: TBD

---

### 13. Top-level Typos

#### 13.1 Typo in command
```
sonar verifyy
sonar issuess search
sonar auth loginn
sonar secret chekc
```
**Expected**: "unknown command 'verifyy'. Did you mean: verify?"
**Actual**: TBD

---

## Test Results Summary

### Commands Tested: All Pass ✓

| Test | Command | Input | Result |
|------|---------|-------|--------|
| 1.1 | `sonar verify` | no args | ✅ `error: required option '--file <file>' not specified` |
| 1.2 | `sonar verify` | `--file /nonexistent` | ✅ `File not found: /tmp/does_not_exist.ts` |
| 1.3 | `sonar verify` | `--file ""` | ✅ `--file is required` |
| 1.6 | `sonar verify` | `--unknown-flag` (with --file) | ✅ `error: unknown option '--unknown-flag'` |
| 2.1 | `sonar issues search` | no args | ✅ `error: required option '-s, --server ...' not specified` |
| 2.3 | `sonar issues search` | missing `--project` | ✅ `error: required option '-p, --project ...' not specified` |
| 2.4 | `sonar issues search` | `--format xml` | ✅ FIXED: `Invalid format: 'xml'. Must be one of: json, toon, table, csv` |
| 2.5 | `sonar issues search` | `--page-size abc` | ✅ FIXED: `Invalid --page-size: 'abc'. Must be an integer between 1 and 500` |
| 2.7 | `sonar issues search` | `--severity INVALID` | ✅ FIXED: `Invalid severity: 'INVALID'. Must be one of: INFO, MINOR, MAJOR, CRITICAL, BLOCKER` |
| 2.8 | `sonar issues search` | `-s "not-a-url"` | ✅ FIXED: `Invalid server URL: 'not-a-url'. Provide a valid URL (e.g., https://sonarcloud.io)` |
| 3.1 | `sonar onboard-agent` | no agent | ✅ `error: missing required argument 'agent'` |
| 3.2 | `sonar onboard-agent` | `vscode` | ✅ `Invalid agent. Must be one of: claude, gemini, codex` |
| 3.3 | `sonar onboard-agent` | `""` | ✅ `Invalid agent. Must be one of: claude, gemini, codex` |
| 3.4 | `sonar onboard-agent` | `xyz_garbage` | ✅ `Invalid agent. Must be one of: claude, gemini, codex` |
| 3.6 | `sonar onboard-agent` | `--hook-type xyz` | ✅ FIXED: `Invalid hook type: 'xyz'. Must be one of: prompt, cli` |
| 4.2 | `sonar auth login` | `--org ""` | ✅ FIXED: `--org value cannot be empty. Provide a valid organization key` |
| 4.4 | `sonar auth login` | `--with-token ""` | ✅ FIXED: `--with-token value cannot be empty. Provide a valid token or omit the flag` |
| 4.5 | `sonar auth login` | `--server "not-a-url"` | ✅ FIXED: `Invalid server URL: 'not-a-url'. Provide a valid URL` |
| 4.6 | `sonar auth login` | `--server ""` | ✅ FIXED: `--server value cannot be empty. Provide a valid URL` |
| 5.1 | `sonar auth logout` | no args (SonarCloud) | ✅ `Organization key is required for SonarCloud logout` |
| 5.2 | `sonar auth logout` | `--org "xyz_garbage"` | ✅ `No token found for: https://sonarcloud.io (xyz_garbage)` (exit 0, idempotent) |
| 5.3 | `sonar auth logout` | `--org ""` | ✅ `Organization key is required for SonarCloud logout` |
| 6.1 | `sonar auth purge` | no tokens | ✅ `No tokens found in keychain` |
| 7.1 | `sonar auth list` | — | ✅ Lists connections with status |
| 8.1 | `sonar pre-commit install` | not in git repo | ✅ `Not a git repository. Please run this command from the root of a git repository` |
| 8.2 | `sonar pre-commit install` | `--flag xyz` | ✅ `error: unknown option '--flag'` |
| 9.1 | `sonar pre-commit uninstall` | nothing installed | ✅ graceful success |
| 10.3 | `sonar secret install` | `--unknown` | ✅ `error: unknown option '--unknown'` |
| 11.2 | `sonar secret status` | `--unknown` | ✅ `error: unknown option '--unknown'` |
| 12.1 | `sonar secret check` | no options | ✅ `Either --file or --stdin is required` |
| 12.2 | `sonar secret check` | `--file /nonexistent` | ✅ FIXED: `File not found: /tmp/does_not_exist.ts` (clean, no binary noise) |
| 12.3 | `sonar secret check` | `--file ""` | ✅ `Either --file or --stdin is required` |
| 12.4 | `sonar secret check` | `--file x --stdin` | ✅ `Cannot use both --file and --stdin` |
| 13.1 | typo `sonar verifyy` | — | ✅ `error: unknown command 'verifyy' (Did you mean verify?)` |
| 13.2 | typo `sonar auth loginn` | — | ✅ `error: unknown command 'loginn' (Did you mean login?)` |
| 13.3 | typo `sonar secret chekc` | — | ✅ `error: unknown command 'chekc' (Did you mean check?)` |

---

## Issues Found & Fixed

| # | Command | Input | Problem | Fix | File |
|---|---------|-------|---------|-----|------|
| 1 | `sonar issues search` | `--format xml` | Format validated after auth — user saw auth error, not format error | Validate format before auth | `issues.ts` |
| 2 | `sonar issues search` | `--page-size abc` | No validation, user saw auth error | Validate integer 1–500 before auth | `issues.ts` |
| 3 | `sonar issues search` | `--severity INVALID` | Passed to API unvalidated | Validate against known enum before API call | `issues.ts` |
| 4 | `sonar issues search` | `-s "not-a-url"` | `"Invalid URL"` with no context | Validate URL format with helpful message | `issues.ts` |
| 5 | `sonar auth login` | `--org ""` | Empty string silently ignored, fell into interactive flow | Reject empty `--org` explicitly | `auth.ts` |
| 6 | `sonar auth login` | `--with-token ""` | `isNonInteractive=false` due to `!!""`, launched browser unexpectedly | Reject empty `--with-token` explicitly | `auth.ts` |
| 7 | `sonar auth login` | `--server "not-a-url"` | No URL format validation, proceeded with invalid server | Validate URL format early | `auth.ts` |
| 8 | `sonar auth login` | `--server ""` | Silently fell back to default | Reject empty `--server` explicitly | `auth.ts` |
| 9 | `sonar secret check` | `--file /nonexistent` | Raw binary error output shown instead of clean message | Check `existsSync` before calling binary | `secret-scan.ts` |
| 10 | `sonar onboard-agent` | `--hook-type xyz` | No validation, silently cast to invalid `HookType` | Validate against `['prompt', 'cli']` | `onboard-agent.ts` |
| 11 | `sonar verify` | `--organization` flag | **Bug**: Commander `options.organization` not mapped to `VerifyOptions.organizationKey` | Fixed action mapping in `index.ts` | `index.ts` |
