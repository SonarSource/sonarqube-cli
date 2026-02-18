// Install sonar-secrets binary from GitHub releases

import {existsSync, mkdirSync, copyFileSync, chmodSync} from 'node:fs';
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

const SCAN_TIMEOUT_MS = 30000; // 30 seconds max for secret scanning
const ISSUE_NUMBER_OFFSET = 1;
const FILE_EXECUTABLE_PERMS = 0o755;

/**
 * Main command: sonar secret install
 */
export async function secretInstallCommand(
  options: { force?: boolean }
): Promise<void> {
  logger.info('\n🔐 Installing sonar-secrets binary\n');

  const platform = detectPlatform();
  logger.info(`Platform: ${platform.os}-${platform.arch}`);

  const binDir = ensureBinDirectory();
  const binaryPath = join(binDir, buildLocalBinaryName(platform));

  try {
    await performInstallation(options, platform, binaryPath);
  } catch (error) {
    // For "already up to date" error, still register hooks but skip full flow
    const isAlreadyUpToDate =
      (error as Error).message === 'Installation skipped - already up to date';
    if (!isAlreadyUpToDate) {
      logInstallationError(error);
      process.exit(1);
    }
  }

  // Register hooks regardless of installation status
  await registerClaudeCodeHooks();
  logInstallationSuccess(binaryPath);
  process.exit(0);
}

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
  logger.info('📡 Fetching latest release from GitHub...');
  const release = await fetchLatestRelease(
    SONAR_SECRETS_REPO.owner,
    SONAR_SECRETS_REPO.name
  );
  logger.info(`   Latest version: ${release.tag_name}`);

  const asset = findAndValidateAsset(release, platform);
  logger.info(`📥 Downloading ${asset.name} (${formatBytes(asset.size)})...`);
  await downloadBinary(asset.browser_download_url, binaryPath);
  logger.info('   ✓ Download complete');

  if (platform.os !== 'windows') {
    await makeExecutable(binaryPath);
    logger.info('   ✓ Made executable');
  }

  // Verify and finalize
  logger.info('🔍 Verifying installation...');
  const installedVersion = await verifyInstallation(binaryPath);
  logger.info(`   ✓ sonar-secrets ${installedVersion} installed successfully`);

  await recordInstallationInState(installedVersion, binaryPath);
}

/**
 * Check command: sonar secret check [--file <path>] [--stdin]
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- S3776: SonarQube cache issue
export const secretCheckCommand = performCheckCommand;

async function performCheckCommand(options: {
  file?: string;
  stdin?: boolean;
}): Promise<void> {
  handleCheckCommand(options).catch(handleScanError);
}

function handleCheckCommand(options: {
  file?: string;
  stdin?: boolean;
}): Promise<void> {
  const env = setupScanEnvironment(options);
  const scanStartTime = Date.now();

  if (options.stdin) {
    return performStdinScan(env.binaryPath, env.authUrl, env.authToken, scanStartTime);
  }
  return performFileScan(env.binaryPath, options.file, env.authUrl, env.authToken, scanStartTime);
}

interface ScanEnvironment {
  binaryPath: string;
  authUrl: string;
  authToken: string;
}

function setupScanEnvironment(options: { file?: string; stdin?: boolean }): ScanEnvironment {
  validateScanOptions(options);

  const binaryPath = setupBinaryPath();
  const { authUrl, authToken } = setupAuth();

  return { binaryPath, authUrl, authToken };
}

function validateScanOptions(options: { file?: string; stdin?: boolean }): void {
  if (!options.file && !options.stdin) {
    logger.error('Error: either --file or --stdin is required');
    process.exit(1);
  }

  if (options.file && options.stdin) {
    logger.error('Error: cannot use both --file and --stdin');
    process.exit(1);
  }
}

function setupBinaryPath(): string {
  const platform = detectPlatform();
  const binDir = join(homedir(), '.sonar-cli', 'bin');
  const binaryPath = join(binDir, buildLocalBinaryName(platform));

  validateCheckCommandEnvironment(binaryPath);

  return binaryPath;
}

function setupAuth(): { authUrl: string; authToken: string } {
  const { authUrl, authToken } = getAuthEnvironment();
  if (!authUrl || !authToken) {
    logAuthConfigError();
    process.exit(1);
  }

  return { authUrl, authToken };
}

async function performStdinScan(
  binaryPath: string,
  authUrl: string,
  authToken: string,
  scanStartTime: number
): Promise<void> {
  logger.debug('Reading from stdin');
  logger.debug(`Using binary: ${binaryPath}`);
  logger.debug(`Auth URL: ${authUrl}`);

  const result = await runScanFromStdin(binaryPath, authUrl, authToken);
  const scanDurationMs = Date.now() - scanStartTime;

  const exitCode = result.exitCode ?? 1;
  if (exitCode === 0) {
    handleScanSuccess(result, scanDurationMs);
  } else {
    handleScanFailure(result, scanDurationMs, exitCode);
  }
}

async function performFileScan(
  binaryPath: string,
  file: string | undefined,
  authUrl: string,
  authToken: string,
  scanStartTime: number
): Promise<void> {
  if (!file) {
    logger.error('Error: file path is required');
    process.exit(1);
  }

  logger.debug(`Scanning file: ${file}`);
  logger.debug(`Using binary: ${binaryPath}`);
  logger.debug(`Auth URL: ${authUrl}`);

  const result = await runScan(binaryPath, file, authUrl, authToken);
  const scanDurationMs = Date.now() - scanStartTime;

  const exitCode = result.exitCode ?? 1;
  if (exitCode === 0) {
    handleScanSuccess(result, scanDurationMs);
  } else {
    handleScanFailure(result, scanDurationMs, exitCode);
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
  await chmod(path, FILE_EXECUTABLE_PERMS);
}

async function checkInstalledVersion(path: string): Promise<string | null> {
  try {
    const result = await spawnProcess(path, ['--version'], {
      stdout: 'pipe',
      stderr: 'pipe'
    });

    if (result.exitCode === 0) {
      // Parse version from output (limit backtracking to max 20 chars per segment)
      const versionRegex = /(\d{1,20}(?:\.\d{1,20}){2,3})/;
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

    // Register Claude Code hooks if on macOS
    await registerClaudeCodeHooks();
  } catch (error) {
    logger.warn('Warning: Failed to update state:', (error as Error).message);
  }
}

async function registerClaudeCodeHooks(): Promise<void> {
  try {
    logger.info('');
    logger.info('⚙️  Registering Claude Code hooks');

    const platform = detectPlatform();

    // Only register hooks on macOS for now
    if (platform.os !== 'macos') {
      logger.info('  Skip: Not on macOS');
      return;
    }

    const sourceHooksDir = join(
      homedir(),
      '.claude',
      'hooks',
      'sonar-secrets'
    );

    // Verify source hooks exist
    if (!existsSync(sourceHooksDir)) {
      logger.warn('  Warning: Hooks template not found at', sourceHooksDir);
      return;
    }

    logger.info(`  Found template hooks at: ${sourceHooksDir}`);

    // Find project root and install hooks there
    const projectRoot = findProjectRoot(process.cwd());
    if (!projectRoot) {
      logger.info('  Note: No project root found (not in a project), skipping');
      return;
    }

    logger.info(`  Found project at: ${projectRoot}`);

    const projectHooksDir = join(projectRoot, '.claude', 'hooks', 'sonar-secrets');
    installHooksToProject(sourceHooksDir, projectHooksDir);

    logger.info('✓ Claude Code hooks installed to project');
    logger.info(`  Location: ${projectHooksDir}`);
  } catch (error) {
    // Non-critical - don't fail installation if hook registration fails
    logger.debug('Debug: Hook registration error:', (error as Error).message);
  }
}

function findProjectRoot(startDir: string): string | null {
  let currentDir = startDir;

  // Search up to 10 levels for package.json or .git
  for (let i = 0; i < 10; i++) {
    if (
      existsSync(join(currentDir, 'package.json')) ||
      existsSync(join(currentDir, '.git'))
    ) {
      return currentDir;
    }

    const parentDir = join(currentDir, '..');
    if (parentDir === currentDir) {
      // Reached filesystem root
      break;
    }
    currentDir = parentDir;
  }

  return null;
}

function installHooksToProject(sourceDir: string, targetDir: string): void {
  // Create target directory
  mkdirSync(targetDir, { recursive: true });

  // Copy hooks.json
  const sourceHooksJson = join(sourceDir, 'hooks.json');
  const targetHooksJson = join(targetDir, 'hooks.json');
  if (existsSync(sourceHooksJson)) {
    copyFileSync(sourceHooksJson, targetHooksJson);
  }

  // Create scripts directory and copy all scripts
  const sourceScriptsDir = join(sourceDir, 'scripts');
  const targetScriptsDir = join(targetDir, 'scripts');
  if (existsSync(sourceScriptsDir)) {
    mkdirSync(targetScriptsDir, { recursive: true });

    const scriptFiles = [
      'setup.sh',
      'prompt-secrets.sh',
      'pretool-secrets.sh'
    ];

    for (const scriptFile of scriptFiles) {
      const sourceScript = join(sourceScriptsDir, scriptFile);
      const targetScript = join(targetScriptsDir, scriptFile);
      if (existsSync(sourceScript)) {
        copyFileSync(sourceScript, targetScript);
        // Make executable
        chmodSync(targetScript, FILE_EXECUTABLE_PERMS);
      }
    }
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
    logger.info(`✓ sonar-secrets ${existingVersion} is already installed (latest)`);
    logger.info('');
    logger.info('Use --force to reinstall');
    return true;
  }

  logger.info(`⚠️  Update available: ${existingVersion} → ${latestVersion}`);
  logger.info('   Updating...\n');
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
    logger.error(`Binary not found for ${platform.os}-${platform.arch}\n`);
    logger.error(`Expected: ${assetName}\n`);
    logger.error(`Available assets:\n  • ${availableAssets}\n`);
    logger.error(`Manual download: https://github.com/${SONAR_SECRETS_REPO.owner}/${SONAR_SECRETS_REPO.name}/releases`);
    throw new Error('No matching binary found for your platform');
  }

  return asset;
}

function logInstallationSuccess(binaryPath: string): void {
  logger.info('');
  logger.info('Installation complete!');
  logger.info('');
  logger.info(`Binary path: ${binaryPath}`);
  logger.info('');
  logger.info('Claude Code hooks:');
  logger.info('  Location: ~/.claude/hooks/sonar-secrets/');
  logger.info('  Hooks are automatically registered on macOS');
  logger.info('');
  logger.info('Manual usage:');
  logger.info(`  sonar-secrets scan <file>`);
  logger.info('');
  logger.info('Check installation status:');
  logger.info('  sonar secret status');
}

function logInstallationError(error: unknown): void {
  logger.error(`\nError: ${(error as Error).message}`);
  logger.info('');
  logger.info('Troubleshooting:');
  logger.info('  • Check your internet connection');
  logger.info('  • Verify GitHub is accessible');
  logger.info('  • Try again later (API rate limiting)');
  logger.info(`  • Manual download: https://github.com/${SONAR_SECRETS_REPO.owner}/${SONAR_SECRETS_REPO.name}/releases`);
}

function validateCheckCommandEnvironment(binaryPath: string): void {
  if (!existsSync(binaryPath)) {
    logger.error('Error: sonar-secrets is not installed');
    logger.info('');
    logger.info('Install with: sonar secret install');
    process.exit(1);
  }
}

function getAuthEnvironment(): { authUrl: string | undefined; authToken: string | undefined } {
  return {
    authUrl: process.env.SONAR_SECRETS_AUTH_URL,
    authToken: process.env.SONAR_SECRETS_TOKEN
  };
}

function logAuthConfigError(): void {
  logger.error('Error: sonar-secrets authentication is not configured');
  logger.info('');
  logger.info('Configure authentication by setting environment variables:');
  logger.info('  export SONAR_SECRETS_AUTH_URL=<url>');
  logger.info('  export SONAR_SECRETS_TOKEN=<token>');
  logger.info('');
  logger.info('For SonarQube Cloud: SONAR_SECRETS_AUTH_URL=https://sonarcloud.io');
  logger.info('For on-premise: SONAR_SECRETS_AUTH_URL=https://your-sonarqube-server');
}

async function runScan(
  binaryPath: string,
  file: string,
  authUrl: string,
  authToken: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return Promise.race([
    spawnProcess(binaryPath, [file], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        SONAR_SECRETS_AUTH_URL: authUrl,
        SONAR_SECRETS_TOKEN: authToken
      }
    }),
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`Scan timed out after ${SCAN_TIMEOUT_MS}ms`)),
        SCAN_TIMEOUT_MS
      )
    )
  ]);
}

async function runScanFromStdin(
  binaryPath: string,
  authUrl: string,
  authToken: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return Promise.race([
    spawnProcess(binaryPath, ['--input'], {
      stdin: 'inherit',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        SONAR_SECRETS_AUTH_URL: authUrl,
        SONAR_SECRETS_TOKEN: authToken
      }
    }),
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`Scan timed out after ${SCAN_TIMEOUT_MS}ms`)),
        SCAN_TIMEOUT_MS
      )
    )
  ]);
}

function handleScanSuccess(result: { stdout: string }, scanDurationMs: number): void {
  try {
    const scanResult = JSON.parse(result.stdout);
    logger.info('');
    logger.info('✅ Scan completed successfully');
    logger.info(`   Duration: ${scanDurationMs}ms`);
    displayScanResults(scanResult);
    logger.info('');
    process.exit(0);
  } catch (parseError) {
    logger.debug(`Failed to parse JSON output: ${(parseError as Error).message}`);
    logger.info('');
    logger.info('✅ Scan completed successfully');
    logger.info('');
    logger.info(result.stdout);
    logger.info('');
    process.exit(0);
  }
}

function displayScanResults(scanResult: {
  issues?: Array<{ message?: string; line?: number; severity?: string }>;
}): void {
  if (!scanResult.issues || !Array.isArray(scanResult.issues)) {
    logger.info('   No issues detected');
    return;
  }

  logger.info(`   Issues found: ${scanResult.issues.length}`);
  if (scanResult.issues.length === 0) {
    return;
  }

  logger.warn('');
  scanResult.issues.forEach((issue, idx) => {
    logger.warn(`   [${idx + ISSUE_NUMBER_OFFSET}] ${issue.message || 'Unknown issue'}`);
    if (issue.line) {
      logger.warn(`       Line: ${issue.line}`);
    }
    if (issue.severity) {
      logger.warn(`       Severity: ${issue.severity}`);
    }
  });
}

function handleScanFailure(
  result: { exitCode: number | null; stderr: string; stdout: string },
  scanDurationMs: number,
  exitCode: number
): void {
  logger.error('');
  logger.error('❌ Scan failed');
  logger.error(`   Exit code: ${exitCode}`);
  logger.error(`   Duration: ${scanDurationMs}ms`);

  if (result.stderr) {
    logger.error('');
    logger.error('Error output:');
    logger.error(result.stderr);
  }

  if (result.stdout) {
    logger.error('');
    logger.error('Output:');
    logger.error(result.stdout);
  }
  logger.error('');
  process.exit(exitCode);
}

function handleScanError(error: unknown): void {
  const errorMessage = (error as Error).message;

  logger.error('');
  logger.error(`❌ Error: ${errorMessage}`);
  logger.info('');

  if (errorMessage.includes('timed out')) {
    logger.info('The scan took longer than 30 seconds.');
    logger.info('Try scanning a smaller file or check system resources.');
  } else if (errorMessage.includes('ENOENT')) {
    logger.info('The binary file was not found or is not executable.');
    logger.info('Reinstall with: sonar secret install --force');
  } else {
    logger.info('Check installation with: sonar secret status');
  }

  logger.info('');
  process.exit(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
