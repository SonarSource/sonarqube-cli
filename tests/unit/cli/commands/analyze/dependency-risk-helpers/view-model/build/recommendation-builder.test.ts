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

import type { FixVersionVM } from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model';
import {
  buildLicenseRecommendation,
  buildMalwareRecommendation,
  buildVulnerabilityRecommendation,
} from '../../../../../../../../src/cli/commands/analyze/dependency-risk-helpers/view-model/build';

describe('recommendation-builder', () => {
  it('malware → REMOVE_PACKAGE with empty fixVersions', () => {
    expect(buildMalwareRecommendation()).toEqual({
      action: 'REMOVE_PACKAGE',
      fixVersions: [],
    });
  });

  it('license → REVIEW_LICENSE with empty fixVersions', () => {
    expect(buildLicenseRecommendation()).toEqual({
      action: 'REVIEW_LICENSE',
      fixVersions: [],
    });
  });

  it('vulnerability with non-empty fixVersions → UPGRADE_PACKAGE mirroring the input', () => {
    const fixes: FixVersionVM[] = [
      { version: '1.5.0', descriptionCode: 'NEAREST_COMPLETE', vulnerabilityIds: [] },
      { version: '2.0.0', descriptionCode: 'LATEST_STABLE', vulnerabilityIds: [] },
    ];

    const rec = buildVulnerabilityRecommendation(fixes);

    expect(rec.action).toBe('UPGRADE_PACKAGE');
    expect(rec.fixVersions).toBe(fixes);
  });

  it('vulnerability with empty fixVersions → NO_FIX_AVAILABLE with empty fixVersions', () => {
    expect(buildVulnerabilityRecommendation([])).toEqual({
      action: 'NO_FIX_AVAILABLE',
      fixVersions: [],
    });
  });
});
