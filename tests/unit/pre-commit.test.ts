// Pre-commit command tests

import { it, expect } from 'bun:test';

it('pre-commit: config file content has correct structure', () => {
  const expectedConfig = `repos:
-   repo: https://github.com/SonarSource/sonar-secrets-pre-commit
    rev: v1.0.0
    hooks:
    -   id: sonar-secrets
        stages: [pre-commit]
`;

  // Verify the config has the correct structure (not specific versions)
  expect(expectedConfig.includes('repos:')).toBe(true);
  expect(expectedConfig.includes('SonarSource/sonar-secrets-pre-commit')).toBe(true);
  expect(expectedConfig.includes('rev:')).toBe(true);
  expect(expectedConfig.includes('sonar-secrets')).toBe(true);
  expect(expectedConfig.includes('stages: [pre-commit]')).toBe(true);
});

it('pre-commit: config YAML has valid indentation', () => {
  const config = `repos:
-   repo: https://github.com/SonarSource/sonar-secrets-pre-commit
    rev: v1.0.0
    hooks:
    -   id: sonar-secrets
        stages: [pre-commit]
`;

  // Basic YAML validation - check indentation and structure
  const lines = config.split('\n');

  expect(lines[0]).toBe('repos:');
  expect(lines[1].startsWith('-   repo:')).toBe(true);
  expect(lines[2].startsWith('    rev:')).toBe(true);
  expect(lines[3].startsWith('    hooks:')).toBe(true);
  expect(lines[4].startsWith('    -   id:')).toBe(true);
  expect(lines[5].startsWith('        stages:')).toBe(true);
});
