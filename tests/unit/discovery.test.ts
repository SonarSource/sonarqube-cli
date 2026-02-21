// Discovery module tests

import { it, expect } from 'bun:test';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverProject } from '../../src/bootstrap/discovery.js';

it('discovery: sonar-project.properties parsing', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-discovery-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    const propsContent = `
# SonarQube properties
sonar.host.url=https://sonarcloud.io
sonar.projectKey=my_project
sonar.projectName=My Project
sonar.organization=my-org
`;
    writeFileSync(join(testDir, 'sonar-project.properties'), propsContent);

    const info = await discoverProject(testDir);

    expect(info.hasSonarProps).toBe(true);
    expect(info.sonarPropsData).toMatchObject({
      hostURL: 'https://sonarcloud.io',
      projectKey: 'my_project',
      projectName: 'My Project',
      organization: 'my-org',
    });
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discovery: .sonarlint/connectedMode.json parsing', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-sonarlint-' + Date.now());
  const sonarlintDir = join(testDir, '.sonarlint');
  mkdirSync(sonarlintDir, { recursive: true });

  try {
    const configContent = {
      sonarQubeUri: 'https://sonarqube.example.com',
      projectKey: 'example_project',
      organization: 'example-org'
    };
    writeFileSync(
      join(sonarlintDir, 'connectedMode.json'),
      JSON.stringify(configContent, null, 2)
    );

    const info = await discoverProject(testDir);

    expect(info.hasSonarLintConfig).toBe(true);
    expect(info.sonarLintData).toMatchObject({
      serverURL: 'https://sonarqube.example.com',
      projectKey: 'example_project',
      organization: 'example-org',
    });
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discovery: sonar-project.properties with comments and empty lines', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-comments-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    const propsContent = `
# This is a comment
sonar.host.url=https://test.com

# Another comment
sonar.projectKey=test_key

# Empty line above
sonar.organization=test-org
`;
    writeFileSync(join(testDir, 'sonar-project.properties'), propsContent);

    const info = await discoverProject(testDir);

    expect(info.hasSonarProps).toBe(true);
    expect(info.sonarPropsData).toMatchObject({
      hostURL: 'https://test.com',
      projectKey: 'test_key',
      organization: 'test-org',
    });
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discovery: no configuration files', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-empty-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    const info = await discoverProject(testDir);

    expect(info.hasSonarProps).toBe(false);
    expect(info.hasSonarLintConfig).toBe(false);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
