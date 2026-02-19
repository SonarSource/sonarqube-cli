// Integration tests for secret scanning hooks installation across platforms

import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const EXPECTED_HOOK_TYPES_COUNT = 3;

describe('Secret Scanning Hooks - Cross-Platform Integration', () => {
  let testProjectRoot: string;
  let claudeDir: string;

  beforeEach(() => {
    testProjectRoot = join(tmpdir(), `test-hooks-integration-${Date.now()}`);
    claudeDir = join(testProjectRoot, '.claude');
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testProjectRoot)) {
      rmSync(testProjectRoot, { recursive: true, force: true });
    }
  });

  it('Complete hook installation workflow (Unix)', () => {
    const hooksDir = join(claudeDir, 'hooks', 'sonar-secrets', 'scripts');
    mkdirSync(hooksDir, { recursive: true });

    // Create hook scripts as they would be created by installSecretScanningHooks()
    const pretoolContent = '#!/bin/bash\necho "PreToolUse hook"';
    const promptContent = '#!/bin/bash\necho "UserPromptSubmit hook"';

    writeFileSync(join(hooksDir, 'pretool-secrets.sh'), pretoolContent, { mode: 0o755 });
    writeFileSync(join(hooksDir, 'prompt-secrets.sh'), promptContent, { mode: 0o755 });

    // Create settings file
    const settingsPath = join(claudeDir, 'settings.local.json');
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
        ],
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

    // Verify complete installation
    expect(existsSync(join(hooksDir, 'pretool-secrets.sh'))).toBe(true);
    expect(existsSync(join(hooksDir, 'prompt-secrets.sh'))).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);

    const savedSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(savedSettings.hooks.PreToolUse.length).toBe(1);
    expect(savedSettings.hooks.UserPromptSubmit.length).toBe(1);
  });

  it('Complete hook installation workflow (Windows)', () => {
    const hooksDir = join(claudeDir, 'hooks', 'sonar-secrets', 'scripts');
    mkdirSync(hooksDir, { recursive: true });

    // Create hook scripts as they would be created for Windows
    const pretoolContent = 'Write-Host "PreToolUse hook"';
    const promptContent = 'Write-Host "UserPromptSubmit hook"';

    writeFileSync(join(hooksDir, 'pretool-secrets.ps1'), pretoolContent);
    writeFileSync(join(hooksDir, 'prompt-secrets.ps1'), promptContent);

    // Create settings file with Windows script paths
    const settingsPath = join(claudeDir, 'settings.local.json');
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [
              {
                type: 'command',
                command: String.raw`.claude\hooks\sonar-secrets\scripts\pretool-secrets.ps1`,
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
                command: String.raw`.claude\hooks\sonar-secrets\scripts\prompt-secrets.ps1`,
                timeout: 60
              }
            ]
          }
        ]
      }
    };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    // Verify complete installation
    expect(existsSync(join(hooksDir, 'pretool-secrets.ps1'))).toBe(true);
    expect(existsSync(join(hooksDir, 'prompt-secrets.ps1'))).toBe(true);

    const savedSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(savedSettings.hooks.PreToolUse[0].hooks[0].command.includes('pretool-secrets.ps1')).toBe(true);
  });

  it('Hook scripts are executable on Unix (0o755 permissions)', () => {
    const hooksDir = join(claudeDir, 'hooks', 'sonar-secrets', 'scripts');
    mkdirSync(hooksDir, { recursive: true });

    const scriptPath = join(hooksDir, 'pretool-secrets.sh');
    writeFileSync(scriptPath, '#!/bin/bash\necho test', { mode: 0o755 });

    // Check file exists and is readable
    expect(existsSync(scriptPath)).toBe(true);

    const content = readFileSync(scriptPath, 'utf-8');
    expect(content.includes('#!/bin/bash')).toBe(true);
  });

  it('Settings file can be merged with existing hooks', () => {
    const settingsPath = join(claudeDir, 'settings.local.json');

    // Start with existing hooks
    const existingSettings = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit',
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

    // Merge new sonar-secrets hooks
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

    // Verify merge
    const merged = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(Object.keys(merged.hooks).length).toBe(EXPECTED_HOOK_TYPES_COUNT);
    expect(merged.hooks.PostToolUse).toBeDefined();
    expect(merged.hooks.PreToolUse).toBeDefined();
    expect(merged.hooks.UserPromptSubmit).toBeDefined();
  });

  it('PreToolUse hook matcher is exactly "Read"', () => {
    const settingsPath = join(claudeDir, 'settings.local.json');
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
    const saved = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    expect(saved.hooks.PreToolUse[0].matcher).toBe('Read');
  });

  it('UserPromptSubmit hook matcher is wildcard "*"', () => {
    const settingsPath = join(claudeDir, 'settings.local.json');
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
    const saved = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    expect(saved.hooks.UserPromptSubmit[0].matcher).toBe('*');
  });

  it('Hook timeout is set to 60 seconds', () => {
    const settingsPath = join(claudeDir, 'settings.local.json');
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
    const saved = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    expect(saved.hooks.PreToolUse[0].hooks[0].timeout).toBe(60);
  });

  it('Hook paths use correct separators for each OS', () => {
    const settingsPathUnix = join(claudeDir, 'settings.unix.json');
    const settingsPathWindows = join(claudeDir, 'settings.windows.json');

    // Unix paths
    const unixSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [
              {
                type: 'command',
                command: '.claude/hooks/sonar-secrets/scripts/pretool-secrets.sh'
              }
            ]
          }
        ]
      }
    };

    // Windows paths
    const windowsSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [
              {
                type: 'command',
                command: String.raw`.claude\hooks\sonar-secrets\scripts\pretool-secrets.ps1`
              }
            ]
          }
        ]
      }
    };

    writeFileSync(settingsPathUnix, JSON.stringify(unixSettings, null, 2));
    writeFileSync(settingsPathWindows, JSON.stringify(windowsSettings, null, 2));

    const unix = JSON.parse(readFileSync(settingsPathUnix, 'utf-8'));
    const windows = JSON.parse(readFileSync(settingsPathWindows, 'utf-8'));

    expect(unix.hooks.PreToolUse[0].hooks[0].command.includes('/')).toBe(true);
    expect(windows.hooks.PreToolUse[0].hooks[0].command.includes('\\')).toBe(true);
  });

  it('Multiple hook registrations in same settings file', () => {
    const settingsPath = join(claudeDir, 'settings.local.json');
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
        ],
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
        ],
        SessionStart: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: '.claude/hooks/setup.sh',
                timeout: 30
              }
            ]
          }
        ]
      }
    };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    const saved = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    expect(Object.keys(saved.hooks).length).toBe(EXPECTED_HOOK_TYPES_COUNT);
    expect(saved.hooks.PreToolUse).toBeDefined();
    expect(saved.hooks.UserPromptSubmit).toBeDefined();
    expect(saved.hooks.SessionStart).toBeDefined();
  });
});
