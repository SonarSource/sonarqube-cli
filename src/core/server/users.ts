/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

// SonarQube Users & tokens API wrapper.

import type { SonarHttpClient } from './http-client.ts';

/** Best-effort token revocation should fail fast when the server is unreachable. */
const REVOKE_USER_TOKEN_TIMEOUT_MS = 10_000;

export class UsersClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  /**
   * Get the current authenticated user
   */
  async getCurrentUser(): Promise<{ id: string } | null> {
    try {
      return await this.client.get<{ id: string }>('/api/users/current');
    } catch {
      return null;
    }
  }

  async hasProvisionProjectsPermission(): Promise<boolean> {
    const result = await this.client.get<{ permissions?: { global?: string[] } }>(
      '/api/users/current',
    );

    return result.permissions?.global?.includes('provisioning') ?? false;
  }

  async checkTokenValidity(): Promise<'valid' | 'invalid'> {
    const result = await this.client.get<{ valid: boolean }>('/api/authentication/validate');
    return result.valid ? 'valid' : 'invalid';
  }

  /**
   * Revoke a user token on the server by its name.
   *
   * The wire field is `name` (matches the `/api/user_tokens/revoke?name=`
   * contract). Internally we keep the field as `tokenName` on `AuthConnection`
   * to disambiguate from other "name" fields in the state (project name,
   * org name, etc.). The translation happens here at the wire boundary.
   */
  async revokeUserToken(tokenName: string): Promise<void> {
    await this.client.postForm(
      '/api/user_tokens/revoke',
      { name: tokenName },
      REVOKE_USER_TOKEN_TIMEOUT_MS,
    );
  }
}
