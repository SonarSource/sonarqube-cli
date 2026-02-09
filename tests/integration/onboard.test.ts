// Integration test for onboarding flow

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverProject } from '../../src/bootstrap/discovery.js';
import { loadConfig, saveConfig, newConfig } from '../../src/bootstrap/config.js';
import { installHooks, areHooksInstalled } from '../../src/bootstrap/hooks.js';

test('integration: full onboarding flow', async () => {
  const testDir = join(tmpdir(), 'sonar-cli-test-integration-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    // Step 1: Create sonar-project.properties
    const propsContent = `
sonar.host.url=https://sonarcloud.io
sonar.projectKey=test_project
sonar.organization=test-org
`;
    writeFileSync(join(testDir, 'sonar-project.properties'), propsContent);

    // Step 2: Discover project
    const projectInfo = await discoverProject(testDir, false);

    assert.ok(projectInfo.hasSonarProps, 'Should discover sonar properties');
    assert.equal(projectInfo.sonarPropsData!.hostURL, 'https://sonarcloud.io');
    assert.equal(projectInfo.sonarPropsData!.projectKey, 'test_project');

    // Step 3: Create and save configuration
    const config = newConfig(
      projectInfo.root,
      projectInfo.name,
      projectInfo.sonarPropsData!.hostURL,
      projectInfo.sonarPropsData!.projectKey,
      projectInfo.sonarPropsData!.organization
    );

    await saveConfig(projectInfo.root, config);

    // Verify config was saved
    const configPath = join(projectInfo.root, '.sonarqube', 'config.json');
    assert.ok(existsSync(configPath), 'Should create config file');

    // Step 4: Load config to verify
    const loadedConfig = await loadConfig(projectInfo.root);
    assert.ok(loadedConfig, 'Should load config');
    assert.equal(loadedConfig!.sonarqube.serverUrl, 'https://sonarcloud.io');
    assert.equal(loadedConfig!.sonarqube.projectKey, 'test_project');
    assert.equal(loadedConfig!.sonarqube.organization, 'test-org');

    // Step 5: Install hooks
    await installHooks(projectInfo.root, 'prompt');

    // Verify hooks
    const installed = await areHooksInstalled(projectInfo.root);
    assert.ok(installed, 'Should have hooks installed');

    // Verify hook script exists
    const hookScript = join(projectInfo.root, '.claude', 'hooks', 'sonar-prompt.sh');
    assert.ok(existsSync(hookScript), 'Should create hook script');

    // Verify settings exists
    const settingsPath = join(projectInfo.root, '.claude', 'settings.local.json');
    assert.ok(existsSync(settingsPath), 'Should create settings.local.json');

    console.log('✅ Full onboarding flow completed successfully');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('integration: onboard with existing .sonarlint config', async () => {
  const testDir = join(tmpdir(), 'sonar-cli-test-sonarlint-' + Date.now());
  const sonarlintDir = join(testDir, '.sonarlint');
  mkdirSync(sonarlintDir, { recursive: true });

  try {
    // Create .sonarlint/connectedMode.json
    const configContent = {
      sonarQubeUri: 'https://sonarqube.example.com',
      projectKey: 'example_project',
      organization: 'example-org'
    };

    writeFileSync(
      join(sonarlintDir, 'connectedMode.json'),
      JSON.stringify(configContent, null, 2)
    );

    // Discover
    const projectInfo = await discoverProject(testDir, false);

    assert.ok(projectInfo.hasSonarLintConfig);
    assert.equal(projectInfo.sonarLintData!.serverURL, 'https://sonarqube.example.com');

    // Create config from discovered data
    const config = newConfig(
      projectInfo.root,
      projectInfo.name,
      projectInfo.sonarLintData!.serverURL,
      projectInfo.sonarLintData!.projectKey,
      projectInfo.sonarLintData!.organization
    );

    await saveConfig(projectInfo.root, config);

    // Verify
    const loaded = await loadConfig(projectInfo.root);
    assert.equal(loaded!.sonarqube.serverUrl, 'https://sonarqube.example.com');

    console.log('✅ Onboarding with existing .sonarlint config completed');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('integration: config persistence across multiple operations', async () => {
  const testDir = join(tmpdir(), 'sonar-cli-test-persistence-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    // Create initial config
    const config1 = newConfig(testDir, 'proj1', 'https://server1.com', 'key1', 'org1');
    await saveConfig(testDir, config1);

    // Load and verify
    let loaded = await loadConfig(testDir);
    assert.equal(loaded!.sonarqube.projectKey, 'key1');

    // Install hooks
    await installHooks(testDir, 'prompt');

    // Load config again (should still exist)
    loaded = await loadConfig(testDir);
    assert.equal(loaded!.sonarqube.projectKey, 'key1');

    // Update config
    const config2 = newConfig(testDir, 'proj1', 'https://server2.com', 'key2', 'org2');
    await saveConfig(testDir, config2);

    // Load and verify update
    loaded = await loadConfig(testDir);
    assert.equal(loaded!.sonarqube.projectKey, 'key2');
    assert.equal(loaded!.sonarqube.serverUrl, 'https://server2.com');

    // Hooks should still be installed
    const installed = await areHooksInstalled(testDir);
    assert.ok(installed);

    console.log('✅ Config persistence test completed');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
