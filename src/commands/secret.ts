// Install sonar-secrets binary from GitHub releases

import {existsSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {spawnProcess} from '../lib/process.js';
import {buildAssetName, buildLocalBinaryName, detectPlatform} from '../lib/platform-detector.js';
import {downloadBinary, fetchLatestRelease, findAssetForPlatform} from '../lib/github-releases.js';
import {loadState, saveState} from '../lib/state-manager.js';
import {VERSION} from '../version.js';
import logger from '../lib/logger.js';
import {BINARY_NAME, SONAR_SECRETS_REPO} from '../lib/install-types.js';

/**
 * Main command: sonar secret install
 */
export async function secretInstallCommand(
  options: { force?: boolean }
): Promise<void> {
  logger.info('\n🔐 Installing sonar-secrets binary\n');

  // 1. Detect platform
  const platform = detectPlatform();
  logger.info(`Platform: ${platform.os}-${platform.arch}`);

  // 2. Ensure installation directory exists
  const binDir = ensureBinDirectory();
  const binaryPath = join(binDir, buildLocalBinaryName(platform));

  try {
    // 3. Check existing installation (unless --force)
    if (existsSync(binaryPath) && !options.force) {
      const existingVersion = await checkInstalledVersion(binaryPath);
      if (existingVersion) {
        // Check for updates
        const latestRelease = await fetchLatestRelease(
          SONAR_SECRETS_REPO.owner,
          SONAR_SECRETS_REPO.name
        );
        const latestVersion = latestRelease.tag_name.replace(/^v/, '');

        if (existingVersion === latestVersion) {
          logger.info(`✓ sonar-secrets ${existingVersion} is already installed (latest)`);
          logger.info('');
          logger.info('Use --force to reinstall');
          process.exit(0);
        } else {
          logger.info(`⚠️  Update available: ${existingVersion} → ${latestVersion}`);
          logger.info('   Updating...\n');
        }
      }
    }

    // 4. Fetch latest release
    logger.info('📡 Fetching latest release from GitHub...');
    const release = await fetchLatestRelease(
      SONAR_SECRETS_REPO.owner,
      SONAR_SECRETS_REPO.name
    );
    logger.info(`   Latest version: ${release.tag_name}`);

    // 5. Find matching asset for platform
    const assetName = buildAssetName(release.tag_name, platform);
    const asset = findAssetForPlatform(release, assetName);

    if (!asset) {
      const availableAssets = release.assets.map(a => a.name).join('\n  • ');
      logger.error(`Binary not found for ${platform.os}-${platform.arch}\n`);
      logger.error(`Expected: ${assetName}\n`);
      logger.error(`Available assets:\n  • ${availableAssets}\n`);
      logger.error(`Manual download: https://github.com/${SONAR_SECRETS_REPO.owner}/${SONAR_SECRETS_REPO.name}/releases`);
      process.exit(1);
    }

    // 6. Download binary
    logger.info(`📥 Downloading ${asset.name} (${formatBytes(asset.size)})...`);
    await downloadBinary(asset.browser_download_url, binaryPath);
    logger.info('   ✓ Download complete');

    // 7. Make executable (Unix only)
    if (platform.os !== 'windows') {
      await makeExecutable(binaryPath);
      logger.info('   ✓ Made executable');
    }

    // 8. Verify installation
    logger.info('🔍 Verifying installation...');
    const installedVersion = await verifyInstallation(binaryPath);
    logger.info(`   ✓ sonar-secrets ${installedVersion} installed successfully`);

    // 9. Record in state
    await recordInstallationInState(installedVersion, binaryPath);

    // 10. Success message
    logger.info('');
    logger.info('✅ Installation complete!');
    logger.info('');
    logger.info(`Binary path: ${binaryPath}`);
    logger.info('');
    logger.info('Next steps:');
    logger.info('  • Binary will be used automatically by Claude Code hooks');
    logger.info(`  • Manual usage: ${binaryPath} scan <file>`);
    logger.info('  • Check status: sonar secret status');

    process.exit(0);

  } catch (error) {
    logger.error(`\nError: ${(error as Error).message}`);
    logger.info('');
    logger.info('Troubleshooting:');
    logger.info('  • Check your internet connection');
    logger.info('  • Verify GitHub is accessible');
    logger.info('  • Try again later (API rate limiting)');
    logger.info(`  • Manual download: https://github.com/${SONAR_SECRETS_REPO.owner}/${SONAR_SECRETS_REPO.name}/releases`);
    process.exit(1);
  }
}

/**
 * Status command: sonar secret status
 */
export async function secretStatusCommand(): Promise<void> {
  const platform = detectPlatform();
  const binDir = join(homedir(), '.sonar-cli', 'bin');
  const binaryPath = join(binDir, buildLocalBinaryName(platform));

  logger.info('\n🔍 Checking sonar-secrets installation status\n');

  if (!existsSync(binaryPath)) {
    logger.info('Status: ❌ Not installed');
    logger.info('');
    logger.info('Install with: sonar secret install');
    process.exit(0);
  }

  const version = await checkInstalledVersion(binaryPath);

  if (version) {
    logger.info(`Status: ✅ Installed (v${version})`);
    logger.info(`Path: ${binaryPath}`);

    // Check for updates
    try {
      const release = await fetchLatestRelease(
        SONAR_SECRETS_REPO.owner,
        SONAR_SECRETS_REPO.name
      );
      const latestVersion = release.tag_name.replace(/^v/, '');

      if (version === latestVersion) {
        logger.info('');
        logger.info('✅ Up to date');
      } else {
        logger.info('');
        logger.info(`⚠️  Update available: v${latestVersion}`);
        logger.info('   Run: sonar secret install');
      }
    } catch (error) {
      logger.debug(`Failed to check for updates: ${(error as Error).message}`);
      logger.warn('');
      logger.warn('Could not check for updates (network/API error)');
    }

    process.exit(0);
  }

  logger.info('Status: ⚠️  Binary exists but not working');
  logger.info(`Path: ${binaryPath}`);
  logger.info('');
  logger.info('Reinstall with: sonar secret install --force');
  process.exit(1);
}

function ensureBinDirectory(): string {
  const binDir = join(homedir(), '.sonar-cli', 'bin');
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }
  return binDir;
}

async function makeExecutable(path: string): Promise<void> {
  const { chmod } = await import('node:fs/promises');
  await chmod(path, 0o755);
}

async function checkInstalledVersion(path: string): Promise<string | null> {
  try {
    const result = await spawnProcess(path, ['--version'], {
      stdout: 'pipe',
      stderr: 'pipe'
    });

    if (result.exitCode === 0) {
      // Parse version from output
      const versionRegex = /(\d+\.\d+\.\d+(?:\.\d+)?)/;
      const match = versionRegex.exec(result.stdout);
      return match ? match[1] : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function verifyInstallation(path: string): Promise<string> {
  const version = await checkInstalledVersion(path);
  if (!version) {
    throw new Error('Installation verification failed. Binary not responding to --version.');
  }
  return version;
}

async function recordInstallationInState(
  version: string,
  path: string
): Promise<void> {
  try {
    const state = loadState(VERSION);

    // Ensure tools structure exists
    state.tools ??= { installed: [] };

    // Remove old entry
    state.tools.installed = state.tools.installed.filter(
      (t) => t.name !== BINARY_NAME
    );

    // Add new entry
    state.tools.installed.push({
      name: BINARY_NAME,
      version,
      path,
      installedAt: new Date().toISOString(),
      installedByCliVersion: VERSION
    });

    saveState(state);
  } catch (error) {
    logger.warn('Warning: Failed to update state:', (error as Error).message);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
