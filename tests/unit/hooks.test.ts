// Hooks installation tests

import { it, expect } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installHooks, areHooksInstalled } from '../../src/bootstrap/hooks.js';

it('hooks: install prompt hook', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-hooks-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    // Install hooks
    await installHooks(testDir, 'prompt');

    // Verify .claude directory exists
    const claudeDir = join(testDir, '.claude');
    expect(existsSync(claudeDir)).toBe(true);

    // Verify hooks directory exists
    const hooksDir = join(claudeDir, 'hooks');
    expect(existsSync(hooksDir)).toBe(true);

    // Verify script file exists
    const scriptPath = join(hooksDir, 'sonar-prompt.sh');
    expect(existsSync(scriptPath)).toBe(true);

    // Verify script is executable
    const stats = statSync(scriptPath);
    const isExecutable = (stats.mode & 0o111) !== 0;
    expect(isExecutable).toBe(true);

    // Verify script content
    const content = readFileSync(scriptPath, 'utf-8');
    expect(content.includes('#!/bin/bash')).toBe(true);
    expect(content.includes('SonarQube')).toBe(true);

    // Verify settings.json exists
    const settingsPath = join(claudeDir, 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);

    // Verify settings content
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.PostToolUse).toBeDefined();
    expect(settings.hooks.PostToolUse.length).toBe(1);
    expect(settings.hooks.PostToolUse[0].matcher).toBe('Edit|Write');
    expect(settings.hooks.PostToolUse[0].hooks[0].timeout).toBe(120);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('hooks: install CLI hook', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-hooks-cli-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    await installHooks(testDir, 'cli');

    const scriptPath = join(testDir, '.claude', 'hooks', 'sonar-prompt.sh');
    const content = readFileSync(scriptPath, 'utf-8');

    // CLI hook should run sonarqube-cli automatically
    expect(content.includes('sonar verify')).toBe(true);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('hooks: areHooksInstalled check', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-hooks-check-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    // Initially not installed
    let installed = await areHooksInstalled(testDir);
    expect(installed).toBe(false);

    // Install hooks
    await installHooks(testDir, 'prompt');

    // Now should be installed
    installed = await areHooksInstalled(testDir);
    expect(installed).toBe(true);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('hooks: overwrite existing hooks', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-hooks-overwrite-' + Date.now());
  const claudeDir = join(testDir, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  try {
    // Create existing settings.json with other hooks
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
      join(claudeDir, 'settings.json'),
      JSON.stringify(existingSettings, null, 2)
    );

    // Install hooks
    await installHooks(testDir, 'prompt');

    // Read updated settings
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));

    // Should have PostToolUse hook
    expect(settings.hooks.PostToolUse).toBeDefined();

    // PreToolUse might be overwritten (depending on implementation)
    // This tests that we don't crash on existing config
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
