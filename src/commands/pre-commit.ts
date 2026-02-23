// Pre-commit command - manage pre-commit hooks for secrets detection

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { spawnProcess } from '../lib/process.js';
import { loadState, saveState, addInstalledSkill } from '../lib/state-manager.js';
import { VERSION } from '../version.js';
import logger from '../lib/logger.js';
import { text, blank, note, info, success, warn, confirmPrompt } from '../ui/index.js';
import { runCommand } from '../lib/run-command.js';

const PRE_COMMIT_CONFIG = '.pre-commit-config.yaml';

export const PRE_COMMIT_CONFIG_CONTENT = `repos:
-   repo: https://github.com/SonarSource/sonar-secrets-pre-commit
    rev: v2.38.0.10279
    hooks:
    -   id: sonar-secrets
        stages: [pre-commit]
`;

type GitConfigScope = 'local' | 'global' | 'system';

/**
 * Check if pre-commit is installed
 */
async function isPreCommitInstalled(): Promise<boolean> {
  try {
    const result = await spawnProcess('pre-commit', ['--version'], {
      stdout: 'pipe',
      stderr: 'pipe'
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Install pre-commit using package manager
 */
async function installPreCommit(): Promise<void> {
  text('Installing pre-commit...');

  const { installCmd, installArgs } = await getInstallCommand();

  text(`  Running: ${installCmd} ${installArgs.join(' ')}`);

  const result = await spawnProcess(installCmd, installArgs, {
    stdout: 'inherit',
    stderr: 'inherit'
  });

  if (result.exitCode !== 0) {
    throw new Error(`Failed to install pre-commit (exit code: ${result.exitCode})`);
  }

  text('  pre-commit installed successfully');
}

/**
 * Determine installation command and arguments based on platform
 */
async function getInstallCommand(): Promise<{ installCmd: string; installArgs: string[] }> {
  const os = platform();

  if (os === 'darwin') {
    return getInstallCommandMacOS();
  }

  if (os === 'linux') {
    return getInstallCommandLinux();
  }

  if (os === 'win32') {
    return getInstallCommandWindows();
  }

  throw new Error(`Unsupported platform: ${os}`);
}

/**
 * Get installation command for macOS (brew first, then pip)
 */
async function getInstallCommandMacOS(): Promise<{ installCmd: string; installArgs: string[] }> {
  const hasBrew = await commandExists('brew');
  if (hasBrew) {
    return { installCmd: 'brew', installArgs: ['install', 'pre-commit'] };
  }

  const pipCmd = await findPipCommand();
  if (pipCmd) {
    return { installCmd: pipCmd, installArgs: ['install', 'pre-commit'] };
  }

  throw new Error('Unable to install pre-commit. Please install brew or pip first.');
}

/**
 * Get installation command for Linux (pip only)
 */
async function getInstallCommandLinux(): Promise<{ installCmd: string; installArgs: string[] }> {
  const pipCmd = await findPipCommand();
  if (pipCmd) {
    return { installCmd: pipCmd, installArgs: ['install', 'pre-commit'] };
  }

  throw new Error('Unable to install pre-commit. Please install pip or use your package manager.');
}

/**
 * Get installation command for Windows (pip only)
 */
async function getInstallCommandWindows(): Promise<{ installCmd: string; installArgs: string[] }> {
  const pipCmd = await findPipCommand();
  if (pipCmd) {
    return { installCmd: pipCmd, installArgs: ['install', 'pre-commit'] };
  }

  throw new Error('Unable to install pre-commit. Please install pip first.');
}

/**
 * Find available pip command (pip3 or pip)
 */
async function findPipCommand(): Promise<string | null> {
  const hasPip3 = await commandExists('pip3');
  if (hasPip3) {
    return 'pip3';
  }

  const hasPip = await commandExists('pip');
  return hasPip ? 'pip' : null;
}

/**
 * Check if a command exists
 */
async function commandExists(command: string): Promise<string | false> {
  try {
    const result = await spawnProcess(command, ['--version'], {
      stdout: 'pipe',
      stderr: 'pipe'
    });
    return result.exitCode === 0 ? command : false;
  } catch {
    return false;
  }
}

/**
 * Create .pre-commit-config.yaml file
 */
async function createPreCommitConfig(projectRoot: string): Promise<void> {
  const configPath = join(projectRoot, PRE_COMMIT_CONFIG);

  if (existsSync(configPath)) {
    warn('.pre-commit-config.yaml already exists, skipping file creation');
    return;
  }

  const fs = await import('node:fs/promises');
  await fs.writeFile(configPath, PRE_COMMIT_CONFIG_CONTENT, 'utf-8');

  text('  Created .pre-commit-config.yaml');
}

/**
 * Run pre-commit autoupdate to get latest hook versions
 */
async function runPreCommitAutoupdate(projectRoot: string): Promise<void> {
  text('Updating hook versions...');
  text('  Running: pre-commit autoupdate');

  const result = await spawnProcess('pre-commit', ['autoupdate'], {
    cwd: projectRoot,
    stdout: 'inherit',
    stderr: 'inherit'
  });

  if (result.exitCode === 0) {
    text('  Hook versions updated');
  } else {
    warn('autoupdate failed, continuing with existing version');
  }

  blank();
}

/**
 * Check if git core.hooksPath is set and at which scope
 */
async function checkGitHooksPath(projectRoot: string): Promise<{ path: string; scope: GitConfigScope } | null> {
  try {
    // Check local first
    let result = await spawnProcess('git', ['config', '--local', '--get', 'core.hooksPath'], {
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe'
    });

    if (result.exitCode === 0 && result.stdout.trim()) {
      return { path: result.stdout.trim(), scope: 'local' };
    }

    // Check global
    result = await spawnProcess('git', ['config', '--global', '--get', 'core.hooksPath'], {
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe'
    });

    if (result.exitCode === 0 && result.stdout.trim()) {
      return { path: result.stdout.trim(), scope: 'global' };
    }

    // Check system
    result = await spawnProcess('git', ['config', '--system', '--get', 'core.hooksPath'], {
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe'
    });

    if (result.exitCode === 0 && result.stdout.trim()) {
      return { path: result.stdout.trim(), scope: 'system' };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Unset git core.hooksPath
 */
async function unsetGitHooksPath(projectRoot: string, scope: GitConfigScope): Promise<void> {
  const scopeFlag = `--${scope}`;
  const result = await spawnProcess('git', ['config', scopeFlag, '--unset-all', 'core.hooksPath'], {
    cwd: projectRoot,
    stdout: 'pipe',
    stderr: 'pipe'
  });

  if (result.exitCode !== 0) {
    throw new Error(`Failed to unset core.hooksPath at ${scope} scope. Error: ${result.stderr}`);
  }
}

/**
 * Record pre-commit installation in state
 */
async function recordPreCommitInState(): Promise<void> {
  try {
    const state = loadState(VERSION);
    addInstalledSkill(state, 'claude-code', 'pre-commit-sonar-secrets');
    saveState(state);
  } catch (err) {
    warn(`Failed to update state: ${(err as Error).message}`);
    logger.warn(`Failed to update state: ${(err as Error).message}`);
    // Don't fail if state update fails
  }
}

/**
 * Run pre-commit commands
 */
async function runPreCommitSetup(projectRoot: string): Promise<void> {
  text('Configuring pre-commit hooks...');

  await handleCustomHooksPath(projectRoot);
  await runPreCommitUninstall(projectRoot);
  await runPreCommitClean(projectRoot);
  await runPreCommitInstall(projectRoot);
}

/**
 * Handle custom Git hooks path if set
 */
async function handleCustomHooksPath(projectRoot: string): Promise<void> {
  const hooksPathInfo = await checkGitHooksPath(projectRoot);
  if (!hooksPathInfo) {
    return;
  }

  logHooksPathWarning(hooksPathInfo);

  const confirm = await confirmPrompt('Unset core.hooksPath and continue?');

  if (!confirm) {
    logCancellationInstructions(hooksPathInfo);
    process.exit(0);
  }

  blank();
  text(`  Unsetting core.hooksPath (${hooksPathInfo.scope} scope)...`);
  await unsetGitHooksPath(projectRoot, hooksPathInfo.scope);
  text('  Unset core.hooksPath');
  blank();
}

/**
 * Log warning about custom hooks path
 */
function logHooksPathWarning(hooksPathInfo: { path: string; scope: GitConfigScope }): void {
  blank();
  warn(`Git core.hooksPath is set to: ${hooksPathInfo.path} (${hooksPathInfo.scope} scope)`);
  note([
    'This means Git is using a custom hooks directory instead of .git/hooks/',
    'Pre-commit requires using the standard .git/hooks/ directory.',
    '',
    'What will happen if we proceed:',
    '  ✓ Pre-commit will be installed successfully',
    '  ✗ Existing hooks in the custom directory will stop working',
    '  ✗ Claude Code hooks (if installed) will be disabled',
    '',
    'Alternative: Manually add sonar-secrets to your existing hook setup',
    'See: https://docs.sonarsource.com/sonarqube-server/~/changes/76/analyzing-source-code/scanners/secrets-cli-beta',
  ]);
}

/**
 * Log cancellation instructions
 */
function logCancellationInstructions(hooksPathInfo: { path: string; scope: GitConfigScope }): void {
  blank();
  text('Installation cancelled.');
  note([
    'To install manually with existing hooks:',
    `1. Add sonar-secrets to your hooks in: ${hooksPathInfo.path}`,
    `2. Or unset core.hooksPath: git config --${hooksPathInfo.scope} --unset-all core.hooksPath`,
  ]);
}

/**
 * Run pre-commit uninstall command
 */
async function runPreCommitUninstall(projectRoot: string): Promise<void> {
  text('  Running: pre-commit uninstall');
  const result = await spawnProcess('pre-commit', ['uninstall'], {
    cwd: projectRoot,
    stdout: 'pipe',
    stderr: 'pipe'
  });

  if (result.exitCode === 0) {
    text('  Uninstalled previous hooks');
  }
}

/**
 * Run pre-commit clean command
 */
async function runPreCommitClean(projectRoot: string): Promise<void> {
  text('  Running: pre-commit clean');
  const result = await spawnProcess('pre-commit', ['clean'], {
    cwd: projectRoot,
    stdout: 'pipe',
    stderr: 'pipe'
  });

  if (result.exitCode === 0) {
    text('  Cleaned pre-commit cache');
  }
}

/**
 * Run pre-commit install command
 */
async function runPreCommitInstall(projectRoot: string): Promise<void> {
  text('  Running: pre-commit install');
  const result = await spawnProcess('pre-commit', ['install'], {
    cwd: projectRoot,
    stdout: 'inherit',
    stderr: 'inherit'
  });

  if (result.exitCode !== 0) {
    throw new Error('Failed to install pre-commit hooks');
  }

  text('  Installed pre-commit hooks');
}

/**
 * Check if current directory is a git repository
 */
async function isGitRepository(projectRoot: string): Promise<boolean> {
  const gitDir = join(projectRoot, '.git');
  return existsSync(gitDir);
}

/**
 * Pre-commit uninstall command
 */
export async function preCommitUninstallCommand(): Promise<void> {
  await runCommand(async () => {
    const projectRoot = process.cwd();

    text('\nRemoving SonarSource secrets pre-commit hook\n');

    if (!await isGitRepository(projectRoot)) {
      throw new Error('Not a git repository. Please run this command from the root of a git repository');
    }

    // Step 1: Uninstall pre-commit hooks
    text('Uninstalling pre-commit hooks...');
    text('  Running: pre-commit uninstall');

    try {
      const uninstallResult = await spawnProcess('pre-commit', ['uninstall'], {
        cwd: projectRoot,
        stdout: 'inherit',
        stderr: 'inherit'
      });

      if (uninstallResult.exitCode === 0) {
        text('  Pre-commit hooks uninstalled');
      } else {
        warn('pre-commit uninstall failed or hooks were not installed');
      }
    } catch {
      warn('pre-commit not found, skipping hook uninstall');
    }

    blank();

    // Step 2: Remove .pre-commit-config.yaml
    const configPath = join(projectRoot, PRE_COMMIT_CONFIG);

    if (existsSync(configPath)) {
      text('Removing configuration file...');
      const fs = await import('node:fs/promises');
      await fs.unlink(configPath);
      text('  Removed .pre-commit-config.yaml');
    } else {
      text('Configuration file not found (already removed)');
    }

    blank();
    success('SonarSource secrets pre-commit hook uninstalled successfully!');
    blank();
  });
}

/**
 * Pre-commit install command
 */
export async function preCommitInstallCommand(): Promise<void> {
  await runCommand(async () => {
    const projectRoot = process.cwd();

    text('\nSetting up Sonar secrets pre-commit hook\n');

    await runInstallSteps(projectRoot);

    blank();
    success('Sonar secrets pre-commit hook installed successfully!');
    blank();
    info('The hook will now run automatically on git commit to detect secrets.');

    await recordPreCommitInState();
  });
}

/**
 * Run all installation steps
 */
async function runInstallSteps(projectRoot: string): Promise<void> {
  if (!await isGitRepository(projectRoot)) {
    throw new Error('Not a git repository. Please run this command from the root of a git repository');
  }

  // Step 1: Check and install pre-commit
  await ensurePreCommitInstalled();

  blank();

  // Step 2: Create .pre-commit-config.yaml
  text('Creating configuration file...');
  await createPreCommitConfig(projectRoot);

  blank();

  // Step 3: Update hook versions
  await runPreCommitAutoupdate(projectRoot);

  // Step 4: Run pre-commit setup commands
  await runPreCommitSetup(projectRoot);
}

/**
 * Ensure pre-commit is installed, install if not present
 */
async function ensurePreCommitInstalled(): Promise<void> {
  const preCommitInstalled = await isPreCommitInstalled();

  if (preCommitInstalled) {
    text('pre-commit is already installed');
    return;
  }

  warn('pre-commit is not installed');
  await installPreCommit();

  // Verify installation
  const verifyInstalled = await isPreCommitInstalled();
  if (!verifyInstalled) {
    throw new Error('pre-commit installation verification failed');
  }
}
