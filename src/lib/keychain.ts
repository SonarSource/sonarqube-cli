// Keychain operations wrapper for keytar

import keytar from 'keytar';

const SERVICE_NAME = 'sonar-cli';

/**
 * Generate keychain account key
 * SonarCloud: "sonarcloud.io:org-key"
 * SonarQube: "hostname"
 */
function generateKeychainAccount(serverURL: string, org?: string): string {
  try {
    const url = new URL(serverURL);
    const hostname = url.hostname;

    // SonarCloud with organization
    if (org) {
      return `${hostname}:${org}`;
    }
    // SonarQube or hostname without organization
    return hostname;
  } catch {
    return serverURL;
  }
}

/**
 * Get token from system keychain
 * For SonarCloud: pass org parameter
 * For SonarQube: org parameter is ignored
 */
export async function getToken(serverURL: string, org?: string): Promise<string | null> {
  const account = generateKeychainAccount(serverURL, org);
  return await keytar.getPassword(SERVICE_NAME, account);
}

/**
 * Save token to system keychain
 * For SonarCloud: pass org parameter
 * For SonarQube: org parameter is ignored
 */
export async function saveToken(serverURL: string, token: string, org?: string): Promise<void> {
  const account = generateKeychainAccount(serverURL, org);
  await keytar.setPassword(SERVICE_NAME, account, token);
}

/**
 * Delete token from system keychain
 * For SonarCloud: pass org parameter
 * For SonarQube: org parameter is ignored
 */
export async function deleteToken(serverURL: string, org?: string): Promise<void> {
  const account = generateKeychainAccount(serverURL, org);
  await keytar.deletePassword(SERVICE_NAME, account);
}

/**
 * Get all credentials for this service
 */
export async function getAllCredentials(): Promise<Array<{ account: string; password: string }>> {
  return await keytar.findCredentials(SERVICE_NAME);
}

/**
 * Clear all tokens for this service
 */
export async function purgeAllTokens(): Promise<void> {
  const credentials = await getAllCredentials();
  for (const cred of credentials) {
    await keytar.deletePassword(SERVICE_NAME, cred.account);
  }
}
