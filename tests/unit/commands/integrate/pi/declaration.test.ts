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

import { supportedIntegrations } from '@/commands/integrate';
import { PI_INTEGRATION_ID, piIntegration } from '@/commands/integrate/pi/declaration.ts';

describe('piIntegration', () => {
  it('is declared as the pi integration, displayed as Pi', () => {
    expect(piIntegration.id).toBe('pi');
    expect(PI_INTEGRATION_ID).toBe('pi');
    expect(piIntegration.displayName).toBe('Pi');
  });

  it('declares no feature yet', () => {
    expect(piIntegration.features).toHaveLength(0);
  });

  it('is registered with the supported integrations', () => {
    expect(supportedIntegrations.get(PI_INTEGRATION_ID)).toBe(piIntegration);
  });
});
