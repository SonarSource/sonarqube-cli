/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

// Config module tests

import { it, expect } from 'bun:test';

import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, saveConfig, newConfig } from '../../src/bootstrap/config.js';

it('config: save and load', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-' + Date.now());
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
    expect(existsSync(configPath)).toBe(true);

    // Load config
    const loaded = await loadConfig(testDir);
    expect(loaded).toBeDefined();
    expect(loaded!.sonarqube.serverUrl).toBe('https://sonarcloud.io');
    expect(loaded!.sonarqube.projectKey).toBe('test_project_key');
    expect(loaded!.sonarqube.organization).toBe('test-org');
    expect(loaded!.project.name).toBe('test-project');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('config: load non-existent returns null', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-nonexistent-' + Date.now());

  const loaded = await loadConfig(testDir);
  expect(loaded).toBe(null);
});

it('config: multiple save/load cycles', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-cycles-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    // First config
    const config1 = newConfig(testDir, 'proj1', 'https://server1.com', 'key1', 'org1');
    await saveConfig(testDir, config1);

    const loaded1 = await loadConfig(testDir);
    expect(loaded1!.sonarqube.projectKey).toBe('key1');

    // Second config (overwrite)
    const config2 = newConfig(testDir, 'proj2', 'https://server2.com', 'key2', 'org2');
    await saveConfig(testDir, config2);

    const loaded2 = await loadConfig(testDir);
    expect(loaded2!.sonarqube.projectKey).toBe('key2');
    expect(loaded2!.sonarqube.serverUrl).toBe('https://server2.com');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
