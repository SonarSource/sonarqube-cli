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
import type {GitHubRelease, PlatformInfo} from '../lib/install-types.js';
import {BINARY_NAME, SONAR_SECRETS_REPO} from '../lib/install-types.js';
import { text, blank, note, success, error, warn, withSpinner, print } from '../ui/index.js';
import { runCommand } from '../lib/run-command.js';

export { secretCheckCommand } from './secret-scan.js';

const FILE_EXECUTABLE_PERMS = 0o755; // rwxr-xr-x
const VERSION_REGEX_MAX_SEGMENT = 20;

/**
 * Core install logic for sonar-secrets binary download and setup
 */
export async function performSecretInstall(
  options: { force?: boolean },
  { binDir }: { binDir?: string } = {}
): Promise<string> {
  const platform = detectPlatform();
  const resolvedBinDir = ensureBinDirectory(binDir);
  const binaryPath = join(resolvedBinDir, buildLocalBinaryName(platform));

  text(`Platform: ${platform.os}-${platform.arch}`);

  try {
    await performInstallation(options, platform, binaryPath);
    text(`  sonar-secrets installed at ${binaryPath}`);
    return binaryPath;
  } catch (err) {
    const isAlreadyUpToDate =
      (err as Error).message === 'Installation skipped - already up to date';
    if (isAlreadyUpToDate) {
      return binaryPath;
    }
    throw err;
  }
}

/**
 * CLI wrapper with process exit handling
 */
export async function secretInstallCommand(
  options: { force?: boolean },
  { binDir }: { binDir?: string } = {}
): Promise<void> {
  await runCommand(async () => {
    text('\nInstalling sonar-secrets binary\n');
    const binaryPath = await performSecretInstall(options, { binDir });
    logInstallationSuccess(binaryPath);
  });
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- installation flow has unavoidable sequential steps
async function performInstallation(
  options: { force?: boolean },
  platform: PlatformInfo,
  binaryPath: string
): Promise<void> {
  // Check existing installation
  if (!options.force) {
    const skipStatus = await checkExistingInstallation(binaryPath);
    if (skipStatus) {
      throw new Error('Installation skipped - already up to date');
    }
  }

  // Fetch and download
  const release = await withSpinner('Fetching latest release from GitHub', () =>
    fetchLatestRelease(SONAR_SECRETS_REPO.owner, SONAR_SECRETS_REPO.name)
  );
  print(`  Latest: ${release.tag_name}`);

  const asset = findAndValidateAsset(release, platform);
  await withSpinner(`Downloading ${asset.name} (${formatBytes(asset.size)})`, () =>
    downloadBinary(asset.browser_download_url, binaryPath)
  );

  if (platform.os !== 'windows') {
    await makeExecutable(binaryPath);
  }

  // Verify and finalize
  const installedVersion = await withSpinner('Verifying installation', () =>
    verifyInstallation(binaryPath)
  );
  print(`  sonar-secrets ${installedVersion}`);

  await recordInstallationInState(installedVersion, binaryPath);
}

/**
 * Status command: sonar secret status
 */
export async function secretStatusCommand({ binDir }: { binDir?: string } = {}): Promise<void> {
  await runCommand(async () => {
    const platform = detectPlatform();
    const resolvedBinDir = binDir ?? join(homedir(), '.sonarqube-cli', 'bin');
    const binaryPath = join(resolvedBinDir, buildLocalBinaryName(platform));

    text('\nChecking sonar-secrets installation status\n');

    if (!existsSync(binaryPath)) {
      text('Status: Not installed');
      text('  Install with: sonar secret install');
      return;
    }

    const version = await checkInstalledVersion(binaryPath);

    if (version) {
      text(`Status: Installed (v${version})`);
      text(`Path: ${binaryPath}`);

      // Check for updates
      try {
        const release = await fetchLatestRelease(
          SONAR_SECRETS_REPO.owner,
          SONAR_SECRETS_REPO.name
        );
        const latestVersion = release.tag_name.replace(/^v/, '');

        if (version === latestVersion) {
          blank();
          success('Up to date');
        } else {
          blank();
          warn(`Update available: v${latestVersion}`);
          text('  Run: sonar secret install');
        }
      } catch (err) {
        logger.debug(`Failed to check for updates: ${(err as Error).message}`);
        warn('Could not check for updates (network/API error)');
      }

      return;
    }

    warn('Binary exists but not working');
    text(`Path: ${binaryPath}`);
    text('  Reinstall with: sonar secret install --force');
    throw new Error('Binary not working. Reinstall with: sonar secret install --force');
  });
}

function ensureBinDirectory(dir?: string): string {
  const binDir = dir ?? join(homedir(), '.sonarqube-cli', 'bin');
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }
  return binDir;
}

async function makeExecutable(path: string): Promise<void> {
  const { chmod } = await import('node:fs/promises');
  await chmod(path, FILE_EXECUTABLE_PERMS);
}

async function checkInstalledVersion(path: string): Promise<string | null> {
  try {
    const result = await spawnProcess(path, ['--version'], {
      stdout: 'pipe',
      stderr: 'pipe'
    });

    if (result.exitCode === 0) {
      // Parse version from output — limit backtracking with fixed max segment length
      // eslint-disable-next-line sonarjs/regex-complexity -- bounded quantifiers prevent catastrophic backtracking
      const pattern = String.raw`(\d{1,${VERSION_REGEX_MAX_SEGMENT}}(?:\.\d{1,${VERSION_REGEX_MAX_SEGMENT}}){2,3})`;
      const versionRegex = new RegExp(pattern);
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

    state.tools ??= { installed: [] };

    state.tools.installed = state.tools.installed.filter(
      (t) => t.name !== BINARY_NAME
    );

    state.tools.installed.push({
      name: BINARY_NAME,
      version,
      path,
      installedAt: new Date().toISOString(),
      installedByCliVersion: VERSION
    });

    saveState(state);
  } catch (err) {
    warn(`Failed to update state: ${(err as Error).message}`);
    logger.warn(`Failed to update state: ${(err as Error).message}`);
  }
}

async function checkExistingInstallation(binaryPath: string): Promise<boolean> {
  if (!existsSync(binaryPath)) {
    return false;
  }

  const existingVersion = await checkInstalledVersion(binaryPath);
  if (!existingVersion) {
    return false;
  }

  const latestRelease = await fetchLatestRelease(
    SONAR_SECRETS_REPO.owner,
    SONAR_SECRETS_REPO.name
  );
  const latestVersion = latestRelease.tag_name.replace(/^v/, '');

  if (existingVersion === latestVersion) {
    text(`sonar-secrets ${existingVersion} is already installed (latest)`);
    text('  Use --force to reinstall');
    return true;
  }

  warn(`Update available: ${existingVersion} → ${latestVersion}`);
  text('  Updating...\n');
  return false;
}

function findAndValidateAsset(
  release: GitHubRelease,
  platform: PlatformInfo
): GitHubRelease['assets'][0] {
  const assetName = buildAssetName(release.tag_name, platform);
  const asset = findAssetForPlatform(release, assetName);

  if (!asset) {
    const availableAssets = release.assets.map(a => a.name).join('\n  • ');
    error(`Binary not found for ${platform.os}-${platform.arch}`);
    error(`Expected: ${assetName}`);
    error(`Available assets:\n  • ${availableAssets}`);
    error(`Manual download: https://github.com/${SONAR_SECRETS_REPO.owner}/${SONAR_SECRETS_REPO.name}/releases`);
    throw new Error('No matching binary found for your platform');
  }

  return asset;
}

function logInstallationSuccess(binaryPath: string): void {
  blank();
  success('Installation complete!');
  note([
    `Binary path: ${binaryPath}`,
    '',
    'Claude Code hooks:',
    '  Location: ~/.claude/hooks/sonar-secrets/',
    '  Hooks are automatically registered on macOS',
    '',
    'Manual usage:',
    '  sonar-secrets scan <file>',
    '',
    'Check installation status:',
    '  sonar secret status',
  ]);
}

function logInstallationError(err: unknown): void {
  blank();
  error(`Error: ${(err as Error).message}`);
  logger.error(`Installation error: ${(err as Error).message}`);
  text([
    '',
    'Troubleshooting:',
    '  • Check your internet connection',
    '  • Verify GitHub is accessible',
    '  • Try again later (API rate limiting)',
    `  • Manual download: https://github.com/${SONAR_SECRETS_REPO.owner}/${SONAR_SECRETS_REPO.name}/releases`,
  ].join('\n'));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
