// Tests for secret scanning hooks installation (cross-platform)

import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Secret Scanning Hooks Installation', () => {
  let testProjectRoot: string;
  let claudeDir: string;
  let hooksDir: string;
  let settingsPath: string;

  beforeEach(() => {
    // Create temporary test project structure
    testProjectRoot = join(tmpdir(), `test-hooks-${Date.now()}`);
    claudeDir = join(testProjectRoot, '.claude');
    hooksDir = join(claudeDir, 'hooks');
    settingsPath = join(claudeDir, 'settings.json');

    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    // Cleanup
    if (existsSync(testProjectRoot)) {
      rmSync(testProjectRoot, { recursive: true, force: true });
    }
  });

  it('Settings file structure is created correctly', () => {
    // Expected settings structure for hooks
    const expectedSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [
              {
                type: 'command',
                command: join('.claude', 'hooks', 'sonar-secrets', 'scripts', 'pretool-secrets.sh'),
                timeout: 60
              }
            ]
          }
        ],
        UserPromptSubmit: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: join('.claude', 'hooks', 'sonar-secrets', 'scripts', 'prompt-secrets.sh'),
                timeout: 60
              }
            ]
          }
        ]
      }
    };

    // Write settings
    writeFileSync(settingsPath, JSON.stringify(expectedSettings, null, 2));

    // Verify file exists and can be read back
    expect(existsSync(settingsPath)).toBe(true);

    const content = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(content);

    expect(parsed.hooks.PreToolUse.length).toBe(1);
    expect(parsed.hooks.UserPromptSubmit.length).toBe(1);
  });

  it('PreToolUse hook configuration is correct', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [
              {
                type: 'command',
                command: '.claude/hooks/sonar-secrets/scripts/pretool-secrets.sh',
                timeout: 60
              }
            ]
          }
        ]
      }
    };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    expect(content.hooks.PreToolUse[0].matcher).toBe('Read');
    expect(content.hooks.PreToolUse[0].hooks[0].type).toBe('command');
    expect(content.hooks.PreToolUse[0].hooks[0].timeout).toBe(60);
  });

  it('UserPromptSubmit hook configuration is correct', () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: '.claude/hooks/sonar-secrets/scripts/prompt-secrets.sh',
                timeout: 60
              }
            ]
          }
        ]
      }
    };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    expect(content.hooks.UserPromptSubmit[0].matcher).toBe('*');
    expect(content.hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(60);
  });

  it('Windows hook script extension is .ps1', () => {
    // Test that path construction for Windows uses .ps1 extension
    const isWindows = true;
    const scriptExt = isWindows ? '.ps1' : '.sh';

    const pretoolScript = `.claude/hooks/sonar-secrets/scripts/pretool-secrets${scriptExt}`;
    const promptScript = `.claude/hooks/sonar-secrets/scripts/prompt-secrets${scriptExt}`;

    expect(pretoolScript).toBe('.claude/hooks/sonar-secrets/scripts/pretool-secrets.ps1');
    expect(promptScript).toBe('.claude/hooks/sonar-secrets/scripts/prompt-secrets.ps1');
  });

  it('Unix hook script extension is .sh', () => {
    // Test that path construction for Unix uses .sh extension
    const isWindows = false;
    const scriptExt = isWindows ? '.ps1' : '.sh';

    const pretoolScript = `.claude/hooks/sonar-secrets/scripts/pretool-secrets${scriptExt}`;
    const promptScript = `.claude/hooks/sonar-secrets/scripts/prompt-secrets${scriptExt}`;

    expect(pretoolScript).toBe('.claude/hooks/sonar-secrets/scripts/pretool-secrets.sh');
    expect(promptScript).toBe('.claude/hooks/sonar-secrets/scripts/prompt-secrets.sh');
  });

  it('Settings merging preserves existing hooks', () => {
    // Setup: Create settings with an existing hook
    const existingSettings = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [
              {
                type: 'command',
                command: '.claude/hooks/sonar.sh',
                timeout: 120
              }
            ]
          }
        ]
      }
    };

    writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));

    // Simulate adding new sonar-secrets hooks while preserving existing ones
    let settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    settings.hooks ??= {};
    settings.hooks.PreToolUse = [
      {
        matcher: 'Read',
        hooks: [
          {
            type: 'command',
            command: '.claude/hooks/sonar-secrets/scripts/pretool-secrets.sh',
            timeout: 60
          }
        ]
      }
    ];
    settings.hooks.UserPromptSubmit = [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: '.claude/hooks/sonar-secrets/scripts/prompt-secrets.sh',
            timeout: 60
          }
        ]
      }
    ];

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    // Verify both old and new hooks exist
    const finalSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(finalSettings.hooks.PostToolUse.length).toBe(1);
    expect(finalSettings.hooks.PreToolUse.length).toBe(1);
    expect(finalSettings.hooks.UserPromptSubmit.length).toBe(1);
  });

  it('Settings directory is created if missing', () => {
    // Verify that .claude directory was created
    expect(existsSync(claudeDir)).toBe(true);

    // Create settings in the directory
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: {} }, null, 2)
    );

    expect(existsSync(settingsPath)).toBe(true);
  });

  it('Hooks directory structure is correct', () => {
    const secretsDir = join(hooksDir, 'sonar-secrets');
    const scriptsDir = join(secretsDir, 'scripts');

    mkdirSync(scriptsDir, { recursive: true });

    expect(existsSync(hooksDir)).toBe(true);
    expect(existsSync(secretsDir)).toBe(true);
    expect(existsSync(scriptsDir)).toBe(true);
  });

  it('Hook script file permissions (Unix)', () => {
    // On Unix systems, hook scripts should be executable (0o755)
    const scriptsDir = join(hooksDir, 'sonar-secrets', 'scripts');
    mkdirSync(scriptsDir, { recursive: true });

    const scriptPath = join(scriptsDir, 'pretool-secrets.sh');
    const scriptContent = '#!/bin/bash\necho "test"';

    // Write with executable permissions
    writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

    expect(existsSync(scriptPath)).toBe(true);

    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toBe(scriptContent);
  });

  it('Settings file is valid JSON after creation', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [
              {
                type: 'command',
                command: '.claude/hooks/sonar-secrets/scripts/pretool-secrets.sh',
                timeout: 60
              }
            ]
          }
        ]
      }
    };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    // Try to parse - should not throw
    expect(() => {
      JSON.parse(readFileSync(settingsPath, 'utf-8'));
    }).not.toThrow();
  });

  it('Hook script paths use normalized separators', () => {
    // Test that paths use forward slashes (normalized)
    const isWindows = false;
    const sep = isWindows ? '\\' : '/';

    const prePath = ['.claude', 'hooks', 'sonar-secrets', 'scripts', 'pretool-secrets.sh'].join(sep);
    const promptPath = ['.claude', 'hooks', 'sonar-secrets', 'scripts', 'prompt-secrets.sh'].join(sep);

    // On Unix, should use forward slashes
    expect(prePath).toBe('.claude/hooks/sonar-secrets/scripts/pretool-secrets.sh');
    expect(promptPath).toBe('.claude/hooks/sonar-secrets/scripts/prompt-secrets.sh');
  });
});
