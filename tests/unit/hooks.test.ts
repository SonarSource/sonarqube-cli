// Hooks installation tests

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installHooks, areHooksInstalled } from '../../src/bootstrap/hooks.js';

test('hooks: install prompt hook', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-hooks-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    // Install hooks
    await installHooks(testDir, 'prompt');

    // Verify .claude directory exists
    const claudeDir = join(testDir, '.claude');
    assert.ok(existsSync(claudeDir), 'Should create .claude directory');

    // Verify hooks directory exists
    const hooksDir = join(claudeDir, 'hooks');
    assert.ok(existsSync(hooksDir), 'Should create hooks directory');

    // Verify script file exists
    const scriptPath = join(hooksDir, 'sonar-prompt.sh');
    assert.ok(existsSync(scriptPath), 'Should create hook script');

    // Verify script is executable
    const stats = statSync(scriptPath);
    const isExecutable = (stats.mode & 0o111) !== 0;
    assert.ok(isExecutable, 'Script should be executable');

    // Verify script content
    const content = readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('#!/bin/bash'), 'Should have bash shebang');
    assert.ok(content.includes('SonarQube'), 'Should mention SonarQube');

    // Verify settings.local.json exists
    const settingsPath = join(claudeDir, 'settings.local.json');
    assert.ok(existsSync(settingsPath), 'Should create settings.local.json');

    // Verify settings content
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.ok(settings.hooks, 'Should have hooks section');
    assert.ok(settings.hooks.PostToolUse, 'Should have PostToolUse hook');
    assert.equal(settings.hooks.PostToolUse.length, 1, 'Should have one matcher');
    assert.equal(settings.hooks.PostToolUse[0].matcher, 'Edit|Write');
    assert.equal(settings.hooks.PostToolUse[0].hooks[0].timeout, 120);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('hooks: install CLI hook', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-hooks-cli-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    await installHooks(testDir, 'cli');

    const scriptPath = join(testDir, '.claude', 'hooks', 'sonar-prompt.sh');
    const content = readFileSync(scriptPath, 'utf-8');

    // CLI hook should run sonarqube-cli automatically
    assert.ok(content.includes('sonar verify'), 'Should include sonar verify command');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('hooks: areHooksInstalled check', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-hooks-check-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    // Initially not installed
    let installed = await areHooksInstalled(testDir);
    assert.equal(installed, false, 'Should not be installed initially');

    // Install hooks
    await installHooks(testDir, 'prompt');

    // Now should be installed
    installed = await areHooksInstalled(testDir);
    assert.equal(installed, true, 'Should be installed after installation');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('hooks: overwrite existing hooks', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-hooks-overwrite-' + Date.now());
  const claudeDir = join(testDir, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  try {
    // Create existing settings.local.json with other hooks
    const existingSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: '.*',
            hooks: [{ type: 'command', command: 'echo test', timeout: 10 }]
          }
        ]
      }
    };

    const fs = await import('fs/promises');
    await fs.writeFile(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify(existingSettings, null, 2)
    );

    // Install hooks
    await installHooks(testDir, 'prompt');

    // Read updated settings
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'));

    // Should have PostToolUse hook
    assert.ok(settings.hooks.PostToolUse, 'Should have PostToolUse');

    // PreToolUse might be overwritten (depending on implementation)
    // This tests that we don't crash on existing config
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
