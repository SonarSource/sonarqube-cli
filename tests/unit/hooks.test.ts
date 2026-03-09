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

import {
  installSecretScanningHooks,
  areHooksInstalled,
} from '../../src/cli/commands/integrate/claude/hooks';

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

      expect(content.includes('sonar analyze secrets --file')).toBe(true);
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
  it('hooks: installs A3S PostToolUse hook with Edit|Write matcher', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-hooks-posttool-' + Date.now());
    mkdirSync(testDir, { recursive: true });

    try {
      await installSecretScanningHooks(testDir);

      const settingsPath = join(testDir, '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));

      expect(settings.hooks.PostToolUse).toBeDefined();
      expect(settings.hooks.PostToolUse.length).toBeGreaterThanOrEqual(1);
      const postToolEntry = settings.hooks.PostToolUse[0];
      expect(postToolEntry.matcher).toBe('Edit|Write');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('hooks: creates sonar-a3s scripts directory with posttool-a3s.sh', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-hooks-a3s-dir-' + Date.now());
    mkdirSync(testDir, { recursive: true });

    try {
      await installSecretScanningHooks(testDir);

      const a3sScriptsDir = join(testDir, '.claude', 'hooks', 'sonar-a3s', 'build-scripts');
      expect(existsSync(a3sScriptsDir)).toBe(true);

      const postToolScript = join(a3sScriptsDir, 'posttool-a3s.sh');
      expect(existsSync(postToolScript)).toBe(true);

      const stats = statSync(postToolScript);
      const isExecutable = (stats.mode & 0o111) !== 0;
      expect(isExecutable).toBe(true);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('hooks: posttool-a3s.sh script contains sonar analyze a3s command', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-hooks-a3s-content-' + Date.now());
    mkdirSync(testDir, { recursive: true });

    try {
      await installSecretScanningHooks(testDir);

      const scriptPath = join(
        testDir,
        '.claude',
        'hooks',
        'sonar-a3s',
        'build-scripts',
        'posttool-a3s.sh',
      );
      const content = readFileSync(scriptPath, 'utf-8');

      expect(content.includes('sonar analyze a3s --file')).toBe(true);
      // PostToolUse is non-blocking — should not emit permissionDecision
      expect(content.includes('permissionDecision')).toBe(false);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('hooks: global install uses absolute paths for PostToolUse command', async () => {
    const fakeGlobalDir = join(tmpdir(), 'sonarqube-cli-test-global-a3s-' + Date.now());
    mkdirSync(fakeGlobalDir, { recursive: true });

    try {
      await installSecretScanningHooks('/some/project', fakeGlobalDir);

      const settingsPath = join(fakeGlobalDir, '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));

      const postToolCommand = settings.hooks.PostToolUse[0].hooks[0].command as string;
      expect(postToolCommand.startsWith(fakeGlobalDir)).toBe(true);
    } finally {
      rmSync(fakeGlobalDir, { recursive: true, force: true });
    }
  });

  it('hooks: project install uses relative paths for PostToolUse command', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-relative-a3s-' + Date.now());
    mkdirSync(testDir, { recursive: true });

    try {
      await installSecretScanningHooks(testDir);

      const settingsPath = join(testDir, '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));

      const postToolCommand = settings.hooks.PostToolUse[0].hooks[0].command as string;
      expect(postToolCommand.startsWith('.claude')).toBe(true);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('hooks: overwrite preserves existing PostToolUse entries from other tools', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-hooks-merge-a3s-' + Date.now());
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    try {
      const fs = await import('node:fs/promises');
      const existing = {
        hooks: {
          PostToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'echo bash ran' }],
            },
          ],
        },
      };
      await fs.writeFile(join(claudeDir, 'settings.json'), JSON.stringify(existing, null, 2));

      await installSecretScanningHooks(testDir);

      const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));

      // Our new sonar-a3s entry should be present
      const a3sEntry = settings.hooks.PostToolUse.find(
        (e: { matcher: string }) => e.matcher === 'Edit|Write',
      );
      expect(a3sEntry).toBeDefined();

      // Existing Bash entry should be preserved
      const bashEntry = settings.hooks.PostToolUse.find(
        (e: { matcher: string }) => e.matcher === 'Bash',
      );
      expect(bashEntry).toBeDefined();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('hooks: areHooksInstalled returns false when settings.json contains malformed JSON', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-hooks-malformed-' + Date.now());
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    try {
      const fs = await import('node:fs/promises');
      // Write invalid JSON to settings.json to trigger the catch block in areHooksInstalled
      await fs.writeFile(join(claudeDir, 'settings.json'), '{ invalid json !!!', 'utf-8');

      const installed = await areHooksInstalled(testDir);
      expect(installed).toBe(false);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
}); // describe('Hooks')
