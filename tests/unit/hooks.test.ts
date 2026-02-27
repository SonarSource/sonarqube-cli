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

// Hooks installation tests

import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setMockUi } from '../../src/ui';

import { installSecretScanningHooks, areHooksInstalled } from '../../src/bootstrap/hooks.js';

describe('Hooks', () => {
  beforeEach(() => {
    setMockUi(true);
  });
  afterEach(() => {
    setMockUi(false);
  });

  it('hooks: install secret scanning hooks creates directory structure', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-hooks-' + Date.now());
    mkdirSync(testDir, { recursive: true });

    try {
      await installSecretScanningHooks(testDir);

      // Verify .claude directory exists
      const claudeDir = join(testDir, '.claude');
      expect(existsSync(claudeDir)).toBe(true);

      // Verify hooks directory exists
      const hooksDir = join(claudeDir, 'hooks');
      expect(existsSync(hooksDir)).toBe(true);

      // Verify sonar-secrets scripts directory exists
      const scriptsDir = join(hooksDir, 'sonar-secrets', 'build-scripts');
      expect(existsSync(scriptsDir)).toBe(true);

      // Verify pretool hook script exists and is executable
      const preToolScript = join(scriptsDir, 'pretool-secrets.sh');
      expect(existsSync(preToolScript)).toBe(true);
      const stats = statSync(preToolScript);
      const isExecutable = (stats.mode & 0o111) !== 0;
      expect(isExecutable).toBe(true);

      // Verify prompt hook script exists
      const promptScript = join(scriptsDir, 'prompt-secrets.sh');
      expect(existsSync(promptScript)).toBe(true);

      // Verify settings.json exists with PreToolUse hook
      const settingsPath = join(claudeDir, 'settings.json');
      expect(existsSync(settingsPath)).toBe(true);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.PreToolUse.length).toBe(1);
      expect(settings.hooks.PreToolUse[0].matcher).toBe('Read');
      expect(settings.hooks.UserPromptSubmit).toBeDefined();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('hooks: pretool script contains sonar analyze and exit code 51', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-hooks-content-' + Date.now());
    mkdirSync(testDir, { recursive: true });

    try {
      await installSecretScanningHooks(testDir);

      const scriptPath = join(
        testDir,
        '.claude',
        'hooks',
        'sonar-secrets',
        'build-scripts',
        'pretool-secrets.sh',
      );
      const content = readFileSync(scriptPath, 'utf-8');

      expect(content.includes('sonar analyze --file')).toBe(true);
      expect(content.includes('exit_code -eq 51')).toBe(true);
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
      await installSecretScanningHooks(testDir);

      // Now should be installed
      installed = await areHooksInstalled(testDir);
      expect(installed).toBe(true);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('hooks: overwrite existing hooks preserves unrelated settings', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-hooks-overwrite-' + Date.now());
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    try {
      // Create existing settings.json with other data
      const existingSettings = {
        permissions: { allow: ['Bash'] },
        someOtherSetting: true,
      };

      const fs = await import('node:fs/promises');
      await fs.writeFile(
        join(claudeDir, 'settings.json'),
        JSON.stringify(existingSettings, null, 2),
      );

      // Install hooks
      await installSecretScanningHooks(testDir);

      // Read updated settings
      const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));

      // Should have PreToolUse and UserPromptSubmit hooks
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.UserPromptSubmit).toBeDefined();

      // Existing data should be preserved
      expect(settings.someOtherSetting).toBe(true);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('hooks: global install puts hooks in globalDir/.claude with absolute command paths', async () => {
    const fakeGlobalDir = join(tmpdir(), 'sonarqube-cli-test-global-home-' + Date.now());
    mkdirSync(fakeGlobalDir, { recursive: true });

    try {
      await installSecretScanningHooks('/some/project', fakeGlobalDir);

      const claudeDir = join(fakeGlobalDir, '.claude');
      const settingsPath = join(claudeDir, 'settings.json');
      expect(existsSync(settingsPath)).toBe(true);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.UserPromptSubmit).toBeDefined();

      // Commands should be absolute paths (contain fakeGlobalDir)
      const preToolCommand = settings.hooks.PreToolUse[0].hooks[0].command as string;
      expect(preToolCommand.startsWith(fakeGlobalDir)).toBe(true);

      const promptCommand = settings.hooks.UserPromptSubmit[0].hooks[0].command as string;
      expect(promptCommand.startsWith(fakeGlobalDir)).toBe(true);
    } finally {
      rmSync(fakeGlobalDir, { recursive: true, force: true });
    }
  });

  it('hooks: project install uses relative command paths', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-relative-' + Date.now());
    mkdirSync(testDir, { recursive: true });

    try {
      await installSecretScanningHooks(testDir);

      const settingsPath = join(testDir, '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));

      const preToolCommand = settings.hooks.PreToolUse[0].hooks[0].command as string;
      // Relative path starts with '.claude', not an absolute path
      expect(preToolCommand.startsWith('.claude')).toBe(true);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
}); // describe('Hooks')
