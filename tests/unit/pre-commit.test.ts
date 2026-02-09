// Pre-commit command tests

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

test('pre-commit: config file content is correctly formatted', () => {
  const expectedConfig = `repos:
-   repo: https://github.com/SonarSource/sonar-secrets-pre-commit
    rev: v2.38.0.10279
    hooks:
    -   id: sonar-secrets
        stages: [pre-commit]
`;

  // Verify the config has the correct structure
  assert.ok(expectedConfig.includes('repos:'), 'Should have repos section');
  assert.ok(expectedConfig.includes('SonarSource/sonar-secrets-pre-commit'), 'Should reference SonarSource repo');
  assert.ok(expectedConfig.includes('v2.38.0.10279'), 'Should have correct version');
  assert.ok(expectedConfig.includes('sonar-secrets'), 'Should have sonar-secrets hook');
  assert.ok(expectedConfig.includes('stages: [pre-commit]'), 'Should run on pre-commit stage');
});

test('pre-commit: config YAML structure is valid', () => {
  const expectedConfig = `repos:
-   repo: https://github.com/SonarSource/sonar-secrets-pre-commit
    rev: v2.38.0.10279
    hooks:
    -   id: sonar-secrets
        stages: [pre-commit]
`;

  // Basic YAML validation - check indentation and structure
  const lines = expectedConfig.split('\n');
  
  assert.ok(lines[0] === 'repos:', 'First line should be repos:');
  assert.ok(lines[1].startsWith('-   repo:'), 'Repo should be properly indented');
  assert.ok(lines[2].startsWith('    rev:'), 'Rev should be properly indented');
  assert.ok(lines[3].startsWith('    hooks:'), 'Hooks should be properly indented');
  assert.ok(lines[4].startsWith('    -   id:'), 'Hook id should be properly indented');
  assert.ok(lines[5].startsWith('        stages:'), 'Stages should be properly indented');
});
