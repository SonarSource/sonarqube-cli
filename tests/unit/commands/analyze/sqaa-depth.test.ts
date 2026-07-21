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

import { InvalidOptionError } from '../../../../src/commands/_common/error.ts';
import {
  labelAnalysisDepth,
  parseSqaaDepthOption,
  resolveAnalysisDepth,
} from '../../../../src/commands/analyze/sqaa-depth.ts';

describe('resolveAnalysisDepth', () => {
  it('defaults single-file to STANDARD on the wire', () => {
    expect(resolveAnalysisDepth(undefined, 'single-file')).toBeUndefined();
  });

  it('defaults multi-file and change-set to DEEP on the wire', () => {
    expect(resolveAnalysisDepth(undefined, 'multi-file')).toBe('DEEP');
    expect(resolveAnalysisDepth(undefined, 'change-set')).toBe('DEEP');
  });

  it('honors explicit --depth STANDARD and DEEP', () => {
    expect(resolveAnalysisDepth('STANDARD', 'change-set')).toBeUndefined();
    expect(resolveAnalysisDepth('DEEP', 'single-file')).toBe('DEEP');
  });

  it('forcedDepth STANDARD overrides change-set default', () => {
    expect(resolveAnalysisDepth(undefined, 'change-set', 'STANDARD')).toBeUndefined();
  });

  it('forcedDepth DEEP overrides single-file default', () => {
    expect(resolveAnalysisDepth(undefined, 'single-file', 'DEEP')).toBe('DEEP');
  });
});

describe('labelAnalysisDepth', () => {
  it('maps wire values to display labels', () => {
    expect(labelAnalysisDepth(undefined)).toBe('STANDARD');
    expect(labelAnalysisDepth('DEEP')).toBe('DEEP');
  });
});

describe('parseSqaaDepthOption', () => {
  it('accepts STANDARD and DEEP', () => {
    expect(parseSqaaDepthOption('STANDARD')).toBe('STANDARD');
    expect(parseSqaaDepthOption('DEEP')).toBe('DEEP');
  });

  it('rejects invalid values', () => {
    expect(() => parseSqaaDepthOption('QUICK')).toThrow(InvalidOptionError);
  });
});
