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

import { describe, expect, it } from 'bun:test';

import {
  resolveDistribution,
  resolveDistributionConfig,
} from '@/core/host/environment/distribution.ts';

describe('distribution', () => {
  it('defaults to standalone when no distribution is provided', () => {
    expect(resolveDistribution(undefined)).toBe('standalone');
  });

  it('returns the configured distribution for known values', () => {
    expect(resolveDistribution('standalone')).toBe('standalone');
  });

  it('resolves centralized feature flags for the distribution', () => {
    expect(resolveDistributionConfig(undefined)).toEqual({
      id: 'standalone',
      enableSelfUpdate: true,
    });
  });

  it('throws for unknown values', () => {
    expect(() => resolveDistribution('custom-channel')).toThrow(
      "Unknown distribution 'custom-channel'. Expected one of: standalone.",
    );
  });
});
