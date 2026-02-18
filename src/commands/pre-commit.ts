// Pre-commit command - manage pre-commit hooks for secrets detection

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { spawnProcess } from '../lib/process.js';
import { loadState, saveState, addInstalledSkill } from '../lib/state-manager.js';
import { VERSION } from '../version.js';
import logger from '../lib/logger.js';

const PRE_COMMIT_CONFIG = '.pre-commit-config.yaml';

const PRE_COMMIT_CONFIG_CONTENT = `repos:
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
  logger.info('📦 Installing pre-commit...');

  const { installCmd, installArgs } = await getInstallCommand();

  logger.info(`   Running: ${installCmd} ${installArgs.join(' ')}`);

  const result = await spawnProcess(installCmd, installArgs, {
    stdout: 'inherit',
    stderr: 'inherit'
  });

  if (result.exitCode !== 0) {
    throw new Error(`Failed to install pre-commit (exit code: ${result.exitCode})`);
  }

  logger.info('   ✓ pre-commit installed successfully');
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
    logger.info('⚠️  .pre-commit-config.yaml already exists');
    logger.info('   Skipping file creation');
    return;
  }
  
  const fs = await import('node:fs/promises');
  await fs.writeFile(configPath, PRE_COMMIT_CONFIG_CONTENT, 'utf-8');
  
  logger.info('   ✓ Created .pre-commit-config.yaml');
}

/**
 * Run pre-commit autoupdate to get latest hook versions
 */
async function runPreCommitAutoupdate(projectRoot: string): Promise<void> {
  logger.info('🔄 Updating hook versions...');
  logger.info('   Running: pre-commit autoupdate');
  
  const result = await spawnProcess('pre-commit', ['autoupdate'], {
    cwd: projectRoot,
    stdout: 'inherit',
    stderr: 'inherit'
  });
  
  if (result.exitCode === 0) {
    logger.info('   ✓ Hook versions updated');
  } else {
    logger.info('   ⚠️  Warning: autoupdate failed, continuing with existing version');
  }
  
  logger.info('');
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
 * Get user confirmation
 */
async function getUserConfirmation(prompt: string): Promise<boolean> {
  process.stdout.write(prompt);

  return new Promise((resolve) => {
    let input = '';

    process.stdin.setEncoding('utf-8');
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      input = data.toString().trim().toLowerCase();
      process.stdin.pause();
      process.stdin.removeAllListeners('data');
      process.stdin.unref();
      resolve(input === 'y' || input === 'yes');
    });
  });
}

/**
 * Record pre-commit installation in state
 */
async function recordPreCommitInState(): Promise<void> {
  try {
    const state = loadState(VERSION);
    addInstalledSkill(state, 'claude-code', 'pre-commit-sonar-secrets');
    saveState(state);
  } catch (error) {
    logger.warn('Warning: Failed to update state:', (error as Error).message);
    // Don't fail if state update fails
  }
}

/**
 * Run pre-commit commands
 */
async function runPreCommitSetup(projectRoot: string): Promise<void> {
  logger.info('🔧 Configuring pre-commit hooks...');

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

  const confirm = await getUserConfirmation('   Unset core.hooksPath and continue? (y/n): ');

  if (!confirm) {
    logCancellationInstructions(hooksPathInfo);
    process.exit(0);
  }

  logger.info('');
  logger.info(`   Unsetting core.hooksPath (${hooksPathInfo.scope} scope)...`);
  await unsetGitHooksPath(projectRoot, hooksPathInfo.scope);
  logger.info('   ✓ Unset core.hooksPath');
  logger.info('');
}

/**
 * Log warning about custom hooks path
 */
function logHooksPathWarning(hooksPathInfo: { path: string; scope: GitConfigScope }): void {
  logger.info('');
  logger.info(`   ⚠️  WARNING: Git core.hooksPath is currently set to: ${hooksPathInfo.path}`);
  logger.info(`   (Set at ${hooksPathInfo.scope} scope)`);
  logger.info('');
  logger.info('   This means Git is using a custom hooks directory instead of .git/hooks/');
  logger.info('   Pre-commit requires using the standard .git/hooks/ directory.');
  logger.info('');
  logger.info('   What will happen if we proceed:');
  logger.info('   ✓ Pre-commit will be installed successfully');
  logger.info('   ✗ Existing hooks in the custom directory will stop working');
  logger.info('   ✗ Claude Code hooks (if installed) will be disabled');
  logger.info('');
  logger.info('   Alternative: Manually add sonar-secrets to your existing hook setup');
  logger.info('   See: https://docs.sonarsource.com/sonarqube-server/~/changes/76/analyzing-source-code/scanners/secrets-cli-beta');
  logger.info('');
}

/**
 * Log cancellation instructions
 */
function logCancellationInstructions(hooksPathInfo: { path: string; scope: GitConfigScope }): void {
  logger.info('');
  logger.info('Installation cancelled.');
  logger.info('');
  logger.info('To install manually with existing hooks:');
  logger.info(`1. Add sonar-secrets to your hooks in: ${hooksPathInfo.path}`);
  logger.info(`2. Or unset core.hooksPath: git config --${hooksPathInfo.scope} --unset-all core.hooksPath`);
}

/**
 * Run pre-commit uninstall command
 */
async function runPreCommitUninstall(projectRoot: string): Promise<void> {
  logger.info('   Running: pre-commit uninstall');
  const result = await spawnProcess('pre-commit', ['uninstall'], {
    cwd: projectRoot,
    stdout: 'pipe',
    stderr: 'pipe'
  });

  if (result.exitCode === 0) {
    logger.info('   ✓ Uninstalled previous hooks');
  }
}

/**
 * Run pre-commit clean command
 */
async function runPreCommitClean(projectRoot: string): Promise<void> {
  logger.info('   Running: pre-commit clean');
  const result = await spawnProcess('pre-commit', ['clean'], {
    cwd: projectRoot,
    stdout: 'pipe',
    stderr: 'pipe'
  });

  if (result.exitCode === 0) {
    logger.info('   ✓ Cleaned pre-commit cache');
  }
}

/**
 * Run pre-commit install command
 */
async function runPreCommitInstall(projectRoot: string): Promise<void> {
  logger.info('   Running: pre-commit install');
  const result = await spawnProcess('pre-commit', ['install'], {
    cwd: projectRoot,
    stdout: 'inherit',
    stderr: 'inherit'
  });

  if (result.exitCode !== 0) {
    throw new Error('Failed to install pre-commit hooks');
  }

  logger.info('   ✓ Installed pre-commit hooks');
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
  try {
    const projectRoot = process.cwd();
    
    logger.info('\n🗑️  Removing SonarSource secrets pre-commit hook\n');
    
    // Check if in a git repository
    if (!await isGitRepository(projectRoot)) {
      logger.error('Error: Not a git repository');
      logger.error('Please run this command from the root of a git repository');
      process.exit(1);
    }
    
    // Step 1: Uninstall pre-commit hooks
    logger.info('🔧 Uninstalling pre-commit hooks...');
    logger.info('   Running: pre-commit uninstall');
    
    const uninstallResult = await spawnProcess('pre-commit', ['uninstall'], {
      cwd: projectRoot,
      stdout: 'inherit',
      stderr: 'inherit'
    });
    
    if (uninstallResult.exitCode === 0) {
      logger.info('   ✓ Pre-commit hooks uninstalled');
    } else {
      logger.info('   ⚠️  Warning: pre-commit uninstall failed or hooks were not installed');
    }
    
    logger.info('');
    
    // Step 2: Remove .pre-commit-config.yaml
    const configPath = join(projectRoot, PRE_COMMIT_CONFIG);
    
    if (existsSync(configPath)) {
      logger.info('📝 Removing configuration file...');
      const fs = await import('node:fs/promises');
      await fs.unlink(configPath);
      logger.info('   ✓ Removed .pre-commit-config.yaml');
    } else {
      logger.info('ℹ️  Configuration file not found (already removed)');
    }
    
    logger.info('');
    logger.info('✅ SonarSource secrets pre-commit hook uninstalled successfully!');
    logger.info('');
    
    process.exit(0);
  } catch (error) {
    logger.error(`\nError: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * Pre-commit install command
 */
export async function preCommitInstallCommand(): Promise<void> {
  try {
    const projectRoot = process.cwd();

    logger.info('\n🔐 Setting up Sonar secrets pre-commit hook\n');

    await runInstallSteps(projectRoot);

    logger.info('');
    logger.info('✅ Sonar secrets pre-commit hook installed successfully!');
    logger.info('');
    logger.info('The hook will now run automatically on git commit to detect secrets.');

    // Record installation in state
    await recordPreCommitInState();

    process.exit(0);
  } catch (error) {
    logger.error(`\nError: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * Run all installation steps
 */
async function runInstallSteps(projectRoot: string): Promise<void> {
  // Check if in a git repository
  if (!await isGitRepository(projectRoot)) {
    logger.error('Error: Not a git repository');
    logger.error('Please run this command from the root of a git repository');
    process.exit(1);
  }

  // Step 1: Check and install pre-commit
  await ensurePreCommitInstalled();

  logger.info('');

  // Step 2: Create .pre-commit-config.yaml
  logger.info('📝 Creating configuration file...');
  await createPreCommitConfig(projectRoot);

  logger.info('');

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
    logger.info('✓ pre-commit is already installed');
    return;
  }

  logger.info('⚠️  pre-commit is not installed');
  await installPreCommit();

  // Verify installation
  const verifyInstalled = await isPreCommitInstalled();
  if (!verifyInstalled) {
    throw new Error('pre-commit installation verification failed');
  }
}
