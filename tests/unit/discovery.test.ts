// Discovery module tests

import { it, expect } from 'bun:test';

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverProject } from '../../src/bootstrap/discovery.js';

it('discovery: sonar-project.properties parsing', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-discovery-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    // Create sonar-project.properties
    const propsContent = `
# SonarQube properties
sonar.host.url=https://sonarcloud.io
sonar.projectKey=my_project
sonar.projectName=My Project
sonar.organization=my-org
sonar.sources=src
sonar.tests=test
`;
    writeFileSync(join(testDir, 'sonar-project.properties'), propsContent);

    // Discover project
    const info = await discoverProject(testDir, false);

    expect(info.hasSonarProps).toBe(true);
    expect(info.sonarPropsData!.hostURL).toBe('https://sonarcloud.io');
    expect(info.sonarPropsData!.projectKey).toBe('my_project');
    expect(info.sonarPropsData!.projectName).toBe('My Project');
    expect(info.sonarPropsData!.organization).toBe('my-org');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discovery: .sonarlint/connectedMode.json parsing', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-sonarlint-' + Date.now());
  const sonarlintDir = join(testDir, '.sonarlint');
  mkdirSync(sonarlintDir, { recursive: true });

  try {
    // Create connectedMode.json
    const configContent = {
      sonarQubeUri: 'https://sonarqube.example.com',
      projectKey: 'example_project',
      organization: 'example-org'
    };
    writeFileSync(
      join(sonarlintDir, 'connectedMode.json'),
      JSON.stringify(configContent, null, 2)
    );

    // Discover project
    const info = await discoverProject(testDir, false);

    expect(info.hasSonarLintConfig).toBe(true);
    expect(info.sonarLintData!.serverURL).toBe('https://sonarqube.example.com');
    expect(info.sonarLintData!.projectKey).toBe('example_project');
    expect(info.sonarLintData!.organization).toBe('example-org');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discovery: sonar-project.properties with comments and empty lines', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-comments-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    // Create properties with comments
    const propsContent = `
# This is a comment
sonar.host.url=https://test.com

# Another comment
sonar.projectKey=test_key

# Empty line above
sonar.organization=test-org
`;
    writeFileSync(join(testDir, 'sonar-project.properties'), propsContent);

    const info = await discoverProject(testDir, false);

    expect(info.hasSonarProps).toBe(true);
    expect(info.sonarPropsData!.hostURL).toBe('https://test.com');
    expect(info.sonarPropsData!.projectKey).toBe('test_key');
    expect(info.sonarPropsData!.organization).toBe('test-org');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discovery: no configuration files', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-empty-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    const info = await discoverProject(testDir, false);

    expect(info.hasSonarProps).toBe(false);
    expect(info.hasSonarLintConfig).toBe(false);
    // Note: hasConfig and config fields removed - we don't use .sonarqube/config.json anymore
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
