# Integration Test Plan

**Core principle**: only `list` commands require authentication. Everything else must work without auth.

## State variables

| Variable | Options |
|---|---|
| `SONAR_CLI_TOKEN` + `SONAR_CLI_SERVER` env vars | both / only one / neither |
| `--token` + `--server` flags | both / only one / neither |
| `sonar-project.properties` | absent / key+url / key only / url only |
| State: active connection | present / absent |
| Keychain token | present (`withKeychainToken`) / absent |
| `sonar-secrets` binary | installed (`withSecretsBinaryInstalled`) / not installed |

---

## `sonar integrate claude` — NO AUTH required

File: `tests/integration/specs/integrate.test.ts`

**Note on interactive mode**: the harness supports `browserToken` option which streams CLI
stdout, detects the loopback OAuth port (`port=NNNNN`), and delivers the token via
`GET http://127.0.0.1:<port>/?token=<value>`. This allows testing the full browser auth
flow without `--non-interactive`.

### Without `--non-interactive` (auth succeeds, no repair triggered)

| # | Props | Token source | Server source | Env vars | Expected |
|---|---|---|---|---|---|
| 1 | absent | none | none | none | exit 0, hooks installed (secrets-only) |
| 2 | key+url | `--token` valid | from props | none | exit 0, full integration |
| 3 | key+url | none | none | `TOKEN`+`SERVER` valid | exit 0, env vars used |
| 4 | key+url | keychain token | from props | none | exit 0, keychain token used |
| 5 | url only (no key) | none | none | none | exit 0, hooks installed (no projectKey → secrets-only) |

### Without `--non-interactive` (interactive browser auth via `browserToken`)

| # | Props | Token source | Server source | `browserToken` | Expected |
|---|---|---|---|---|---|
| 6 | key+url | none (no token) | from props | valid token | exit 0, full integration after browser auth |
| 7 | key+url | `--token` invalid | from props | valid token | exit 0, browser auth replaces invalid token |

### With `--non-interactive` (degraded mode — no browser)

| # | Props | Token source | Server source | Env vars | Expected |
|---|---|---|---|---|---|
| 8  | key+url | `--token` invalid | from props | none | exit 0, hooks installed (degraded) |
| 9  | key+url | none | none | none | exit 0, hooks installed (degraded, no token) |
| 10 | key+url | none | none | only `TOKEN` (no `SERVER`) | exit 0, warn about missing SERVER, url from props |

### With `--non-interactive` (additional flag/config scenarios)

| # | Props | Token source | Server source | Flags | Expected |
|---|---|---|---|---|---|
| 11 | key+url | `--token` valid | `--server` flag | `--non-interactive` | exit 0, `--server` overrides props url |
| 12 | absent  | `--token` valid | `--server` flag | `--project --non-interactive` | exit 0, full integration without props |
| 13 | key+url | `--token` valid | from props | `--non-interactive --skip-hooks` | exit 0, hooks NOT installed |
| 14 | key+url | `--token` valid | from props | `--non-interactive` | settings.json has PreToolUse hook |
| 15 | key+url | `--token` valid | from props | `--non-interactive` | pretool-secrets.sh exists and is executable |

---

## `sonar list issues` — AUTH REQUIRED

File: `tests/integration/specs/list-issues-auth.test.ts`

(Complements existing `list-issues.test.ts` which already covers happy-path and basic errors)

| # | Token source | Server source | `--project` | Expected |
|---|---|---|---|---|
| 1 | `--token` valid | `--server` | present | exit 0, JSON output |
| 2 | none | none | present | exit 1, "No server URL found" |
| 3 | `--token` invalid | `--server` | present | exit 1 (401) |
| 4 | none | none | present | `TOKEN`+`SERVER` env → exit 0 |
| 5 | none | none | present | only `SONAR_CLI_TOKEN` env → exit 1, warn about missing SERVER |
| 6 | none | none | present | only `SONAR_CLI_SERVER` env → exit 1, warn about missing TOKEN |
| 7 | `--token` valid | `--server` | absent | exit 1 (required option missing) |
| 8 | `--token` valid | unreachable server | present | exit 1 |
| 9 | keychain token | state connection | present | exit 0, keychain token used |

---

## `sonar list projects` — AUTH REQUIRED (state + keychain)

File: `tests/integration/specs/list-projects.test.ts`

| # | State connection | Keychain token | Expected |
|---|---|---|---|
| 1 | absent | absent | exit 1, "No active connection found. Run: sonar auth login" |
| 2 | present | absent | exit 1, "No token found. Run: sonar auth login" |
| 3 | present | present (valid) | exit 0, JSON with projects array |
| 4 | present | present (invalid) | exit 1 (401) |

Note: `list projects` uses keychain directly (not `resolveAuth`), so env vars `SONAR_CLI_TOKEN`/`SONAR_CLI_SERVER` are NOT used here. This is a known design inconsistency vs `list issues`.

---

## `sonar analyze secrets` — NO AUTH required

File: `tests/integration/specs/analyze-secrets.test.ts`

(Complements existing `secret-scan.test.ts`)

| # | Binary | Source | Content | Auth env vars | Expected |
|---|---|---|---|---|---|
| 1 | installed | `--file` | no secrets | none | exit 0 |
| 2 | installed | `--file` | has secrets | none | exit 51 |
| 3 | installed | `--stdin` | no secrets | none | exit 0 |
| 4 | installed | `--stdin` | has secrets | none | exit 51 |
| 5 | not installed | `--file` | — | none | exit 1, "not installed" message |
| 6 | installed | neither | — | none | exit 1 |
| 7 | installed | `--file` non-existent path | — | none | exit 1 |
| 8 | installed | `--file` | no secrets | `SONAR_SECRETS_AUTH_URL`+`TOKEN` set | exit 0, auth env vars passed through |
| 9 | installed | `--file` | no secrets | auth url set but binary absent | exit 1 |

---

## `sonar auth login` — manages auth

File: `tests/integration/specs/auth.test.ts`

| # | `--with-token` | `--server` | State after | Expected |
|---|---|---|---|---|
| 1 | valid token | `--server` fake | keychain has token | exit 0 |
| 2 | valid token | absent | uses SonarCloud default | exit 0 |
| 3 | absent | — | — | skip (requires interactive browser) |

---

## `sonar auth logout` — manages auth

File: `tests/integration/specs/auth.test.ts`

| # | State | Keychain | Expected |
|---|---|---|---|
| 1 | connection present | token present | exit 0, token removed from keychain |
| 2 | connection absent, `--server` given | token absent | exit 0 (graceful, nothing to remove) |

---

## `sonar auth purge` — manages auth

File: `tests/integration/specs/auth.test.ts`

| # | Keychain | Expected |
|---|---|---|
| 1 | multiple tokens | exit 0, all tokens removed |
| 2 | empty | exit 0 |

---

## `sonar auth status` — shows auth state

File: `tests/integration/specs/auth.test.ts`

| # | State connection | Keychain token | Expected |
|---|---|---|---|
| 1 | absent | absent | exit 0, output indicates not authenticated |
| 2 | present | absent | exit 0, shows connection info, token missing |
| 3 | present | present (valid) | exit 0, shows connection + token valid |
| 4 | present | present (invalid) | exit 0, shows connection + token invalid |

---

## `sonar install secrets` — NO AUTH required

File: `tests/integration/specs/install-secrets.test.ts`

| # | Binary | Flag | Expected |
|---|---|---|---|
| 1 | not installed | `--status` | exit 0, output indicates not installed |
| 2 | installed | `--status` | exit 0, output indicates installed |

Note: actual download scenarios are not suitable for integration tests (network dependency).

---

## Known issues to fix before/during implementation

1. **`list projects` does not use `resolveAuth`** — unlike `list issues`, it reads from state+keychain only. Env vars `SONAR_CLI_TOKEN`/`SONAR_CLI_SERVER` are ignored. Design inconsistency.

2. **`auth login --with-token` keychain interaction** — needs `withActiveConnection` + `withKeychainToken` to verify state is written correctly after login.

3. **`analyze secrets` exit codes** — verify binary mock returns exit 51 for secrets found vs exit 0 for clean scan (check existing mock binary behavior).
