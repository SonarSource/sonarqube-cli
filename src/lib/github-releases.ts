// GitHub releases API client for downloading sonar-secrets binary

import type { GitHubRelease, GitHubAsset } from './install-types.js';
import logger from './logger.js';
import { VERSION } from '../version.js';

const GITHUB_API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

/**
 * Fetch latest release from GitHub
 * Implements retry logic with exponential backoff
 */
export async function fetchLatestRelease(
  owner: string,
  repo: string
): Promise<GitHubRelease> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases/latest`;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      logger.debug(`Fetching release (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})...`);

      const response = await fetch(url, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': `sonarqube-cli/${VERSION}`
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      if (!response.ok) {
        if (response.status === 403) {
          // Rate limited - wait longer before retry
          logger.warn(`GitHub API rate limited. Retrying in ${RETRY_DELAY_MS * attempt}ms...`);
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }

        lastError = new Error(`GitHub API error: ${response.status} ${response.statusText}`);
        if (attempt < MAX_RETRY_ATTEMPTS) {
          logger.debug(`${lastError.message}. Retrying...`);
          await sleep(RETRY_DELAY_MS * attempt);
        }
        continue;
      }

      const data = await response.json();
      return data as GitHubRelease;

    } catch (error) {
      lastError = error as Error;

      if (attempt < MAX_RETRY_ATTEMPTS) {
        logger.debug(`Request failed: ${lastError.message}. Retrying...`);
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError ?? new Error(`Failed to fetch release after ${MAX_RETRY_ATTEMPTS} attempts`);
}

/**
 * Find asset matching platform in release
 */
export function findAssetForPlatform(
  release: GitHubRelease,
  assetName: string
): GitHubAsset | null {
  const asset = release.assets.find(asset => asset.name === assetName);
  return asset ?? null;
}

/**
 * Download binary from URL to destination path
 */
export async function downloadBinary(
  url: string,
  destinationPath: string
): Promise<void> {
  logger.debug(`Downloading from: ${url}`);

  const response = await fetch(url, {
    headers: {
      'User-Agent': `sonarqube-cli/${VERSION}`
    },
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();

  const fs = await import('node:fs/promises');
  await fs.writeFile(destinationPath, Buffer.from(buffer));

  logger.debug(`Downloaded ${buffer.byteLength} bytes`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
