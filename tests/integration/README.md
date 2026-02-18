# Integration Tests

Integration tests verify real behavior of CLI commands with real dependencies (binaries, APIs, filesystem).

## Required Environment Variables

To run integration tests, set the following environment variables:

### For sonar-secrets checks

```bash
export SONAR_SECRETS_AUTH_URL="https://sonarcloud.io"
export SONAR_SECRETS_TOKEN="<your-sonarcloud-token>"
```

**How to get a token:**
- Go to https://sonarcloud.io
- Sign in to your account
- Account → Security → Generate token
- Copy the token

**Alternative:** If you don't have a token, integration tests for sonar-secrets will be skipped gracefully.

### For onboard-agent tests

```bash
export SONARCLOUD_TOKEN="<your-sonarcloud-token>"
```

(Can be the same value as `SONAR_SECRETS_TOKEN`)

## Running Integration Tests

```bash
# Set environment variables
export SONAR_SECRETS_TOKEN="sqp_xxxxx"
export SONARCLOUD_TOKEN="sqp_xxxxx"

# Run integration tests
npm run test:integration

# Or run all tests (unit + integration)
npm run test:all
```

## How Tests Work

### Automatic Binary Download

Before running sonar-secrets integration tests:
- Checks for binary in `~/.sonar-cli/bin/sonar-secrets`
- If missing - automatically downloads and installs from GitHub releases
- Uses real binary from official releases

### Process

```
beforeAll() →
  ✓ Check sonar-secrets binary exists
  ✓ If not → download via `dist/sonar-cli secret install`

each test →
  ✓ Call `dist/sonar-cli secret check --stdin` or `--file`
  ✓ Verify exit code and output
  ✓ Clean up temporary files

afterAll() →
  ✓ Optional cleanup
```

## Test Structure

```
tests/integration/
├── README.md                    # This file
├── onboard.test.ts             # Tests for onboard-agent command
└── secret-check.test.ts        # Tests for sonar secret check (stdin + file)
```

## What's NOT Tested Here

- Thread safety
- Edge cases (tested in unit tests)
- Internal function logic (tested in unit tests)

## Troubleshooting

### "sonar-secrets command not found"

```bash
# Install binary manually
dist/sonar-cli secret install
```

### "Scan timed out"

Timeout on large files or slow internet is acceptable behavior.

### "Token authentication failed"

Check that:
1. Token hasn't expired (generate new one on sonarcloud.io)
2. Environment variable is set correctly: `echo $SONAR_SECRETS_TOKEN`
3. Test has access to the variable

### Tests Skipped

If token is not set - tests are skipped automatically:

```typescript
if (!process.env.SONAR_SECRETS_TOKEN) {
  test.skip('SONAR_SECRETS_TOKEN not set', () => {})
}
```

This is normal for local development.

## CI/CD

In GitHub Actions, add secrets:

```yaml
env:
  SONAR_SECRETS_TOKEN: ${{ secrets.SONAR_SECRETS_TOKEN }}
  SONARCLOUD_TOKEN: ${{ secrets.SONARCLOUD_TOKEN }}

jobs:
  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: npm run test:integration
```
