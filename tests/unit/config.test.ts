// Config module tests

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, saveConfig, newConfig } from '../../src/bootstrap/config.js';

test('config: save and load', async () => {
  const testDir = join(tmpdir(), 'sonar-cli-test-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    // Create config
    const config = newConfig(
      testDir,
      'test-project',
      'https://sonarcloud.io',
      'test_project_key',
      'test-org'
    );

    // Save config
    await saveConfig(testDir, config);

    // Verify file exists
    const configPath = join(testDir, '.sonarqube', 'config.json');
    assert.ok(existsSync(configPath), 'Config file should exist');

    // Load config
    const loaded = await loadConfig(testDir);
    assert.ok(loaded, 'Should load config');
    assert.equal(loaded!.sonarqube.serverUrl, 'https://sonarcloud.io');
    assert.equal(loaded!.sonarqube.projectKey, 'test_project_key');
    assert.equal(loaded!.sonarqube.organization, 'test-org');
    assert.equal(loaded!.project.name, 'test-project');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('config: load non-existent returns null', async () => {
  const testDir = join(tmpdir(), 'sonar-cli-test-nonexistent-' + Date.now());

  const loaded = await loadConfig(testDir);
  assert.equal(loaded, null, 'Should return null for non-existent config');
});

test('config: multiple save/load cycles', async () => {
  const testDir = join(tmpdir(), 'sonar-cli-test-cycles-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    // First config
    const config1 = newConfig(testDir, 'proj1', 'https://server1.com', 'key1', 'org1');
    await saveConfig(testDir, config1);

    const loaded1 = await loadConfig(testDir);
    assert.equal(loaded1!.sonarqube.projectKey, 'key1');

    // Second config (overwrite)
    const config2 = newConfig(testDir, 'proj2', 'https://server2.com', 'key2', 'org2');
    await saveConfig(testDir, config2);

    const loaded2 = await loadConfig(testDir);
    assert.equal(loaded2!.sonarqube.projectKey, 'key2');
    assert.equal(loaded2!.sonarqube.serverUrl, 'https://server2.com');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
