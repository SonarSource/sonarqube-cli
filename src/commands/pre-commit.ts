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
  const os = platform();
  
  logger.info('📦 Installing pre-commit...');
  
  let installCmd: string;
  let installArgs: string[];
  
  // Determine installation method based on OS
  if (os === 'darwin') {
    // macOS - try brew first, fall back to pip
    const hasBrew = await commandExists('brew');
    if (hasBrew) {
      installCmd = 'brew';
      installArgs = ['install', 'pre-commit'];
    } else {
      // Brew not available, try pip
      const hasPip = await commandExists('pip3') || await commandExists('pip');
      if (hasPip) {
        installCmd = hasPip === 'pip3' ? 'pip3' : 'pip';
        installArgs = ['install', 'pre-commit'];
      } else {
        throw new Error('Unable to install pre-commit. Please install brew or pip first.');
      }
    }
  } else if (os === 'linux') {
    // Linux - check for different package managers
    const hasPip = await commandExists('pip3') || await commandExists('pip');
    if (hasPip) {
      installCmd = hasPip === 'pip3' ? 'pip3' : 'pip';
      installArgs = ['install', 'pre-commit'];
    } else {
      throw new Error('Unable to install pre-commit. Please install pip or use your package manager.');
    }
  } else if (os === 'win32') {
    // Windows - use pip
    const hasPip = await commandExists('pip3') || await commandExists('pip');
    if (hasPip) {
      installCmd = hasPip === 'pip3' ? 'pip3' : 'pip';
      installArgs = ['install', 'pre-commit'];
    } else {
      throw new Error('Unable to install pre-commit. Please install pip first.');
    }
  } else {
    throw new Error(`Unsupported platform: ${os}`);
  }
  
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
async function checkGitHooksPath(projectRoot: string): Promise<{ path: string; scope: 'local' | 'global' | 'system' } | null> {
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
async function unsetGitHooksPath(projectRoot: string, scope: 'local' | 'global' | 'system'): Promise<void> {
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
    process.stdin.once('data', (data) => {
      input = data.toString().trim().toLowerCase();
      process.stdin.destroy();
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
  
  // Check if core.hooksPath is set
  const hooksPathInfo = await checkGitHooksPath(projectRoot);
  if (hooksPathInfo) {
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
    
    const confirm = await getUserConfirmation('   Unset core.hooksPath and continue? (y/n): ');
    
    if (!confirm) {
      logger.info('');
      logger.info('Installation cancelled.');
      logger.info('');
      logger.info('To install manually with existing hooks:');
      logger.info(`1. Add sonar-secrets to your hooks in: ${hooksPathInfo.path}`);
      logger.info(`2. Or unset core.hooksPath: git config --${hooksPathInfo.scope} --unset-all core.hooksPath`);
      process.exit(0);
    }
    
    logger.info('');
    logger.info(`   Unsetting core.hooksPath (${hooksPathInfo.scope} scope)...`);
    await unsetGitHooksPath(projectRoot, hooksPathInfo.scope);
    logger.info('   ✓ Unset core.hooksPath');
    logger.info('');
  }
  
  // Run: pre-commit uninstall
  logger.info('   Running: pre-commit uninstall');
  const uninstallResult = await spawnProcess('pre-commit', ['uninstall'], {
    cwd: projectRoot,
    stdout: 'pipe',
    stderr: 'pipe'
  });
  
  if (uninstallResult.exitCode === 0) {
    logger.info('   ✓ Uninstalled previous hooks');
  }
  
  // Run: pre-commit clean
  logger.info('   Running: pre-commit clean');
  const cleanResult = await spawnProcess('pre-commit', ['clean'], {
    cwd: projectRoot,
    stdout: 'pipe',
    stderr: 'pipe'
  });
  
  if (cleanResult.exitCode === 0) {
    logger.info('   ✓ Cleaned pre-commit cache');
  }
  
  // Run: pre-commit install
  logger.info('   Running: pre-commit install');
  const installResult = await spawnProcess('pre-commit', ['install'], {
    cwd: projectRoot,
    stdout: 'inherit',
    stderr: 'inherit'
  });
  
  if (installResult.exitCode !== 0) {
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
    
    // Check if in a git repository
    if (!await isGitRepository(projectRoot)) {
      logger.error('Error: Not a git repository');
      logger.error('Please run this command from the root of a git repository');
      process.exit(1);
    }
    
    // Step 1: Check if pre-commit is installed
    const preCommitInstalled = await isPreCommitInstalled();

    if (preCommitInstalled) {
      logger.info('✓ pre-commit is already installed');
    } else {
      logger.info('⚠️  pre-commit is not installed');
      await installPreCommit();

      // Verify installation
      if (!await isPreCommitInstalled()) {
        throw new Error('pre-commit installation verification failed');
      }
    }
    
    logger.info('');
    
    // Step 2: Create .pre-commit-config.yaml
    logger.info('📝 Creating configuration file...');
    await createPreCommitConfig(projectRoot);
    
    logger.info('');
    
    // Step 3: Update hook versions
    await runPreCommitAutoupdate(projectRoot);
    
    // Step 4: Run pre-commit setup commands
    await runPreCommitSetup(projectRoot);
    
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
