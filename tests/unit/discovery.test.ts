// Discovery module tests

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverProject } from '../../src/bootstrap/discovery.js';

test('discovery: sonar-project.properties parsing', async () => {
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

    assert.ok(info.hasSonarProps, 'Should detect sonar-project.properties');
    assert.equal(info.sonarPropsData!.hostURL, 'https://sonarcloud.io');
    assert.equal(info.sonarPropsData!.projectKey, 'my_project');
    assert.equal(info.sonarPropsData!.projectName, 'My Project');
    assert.equal(info.sonarPropsData!.organization, 'my-org');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('discovery: .sonarlint/connectedMode.json parsing', async () => {
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

    assert.ok(info.hasSonarLintConfig, 'Should detect .sonarlint config');
    assert.equal(info.sonarLintData!.serverURL, 'https://sonarqube.example.com');
    assert.equal(info.sonarLintData!.projectKey, 'example_project');
    assert.equal(info.sonarLintData!.organization, 'example-org');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('discovery: sonar-project.properties with comments and empty lines', async () => {
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

    assert.ok(info.hasSonarProps);
    assert.equal(info.sonarPropsData!.hostURL, 'https://test.com');
    assert.equal(info.sonarPropsData!.projectKey, 'test_key');
    assert.equal(info.sonarPropsData!.organization, 'test-org');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('discovery: no configuration files', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-empty-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    const info = await discoverProject(testDir, false);

    assert.equal(info.hasSonarProps, false, 'Should not have sonar props');
    assert.equal(info.hasSonarLintConfig, false, 'Should not have sonarlint config');
    // Note: hasConfig and config fields removed - we don't use .sonarqube/config.json anymore
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
