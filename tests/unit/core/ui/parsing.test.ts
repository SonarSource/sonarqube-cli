import { describe, expect, it } from 'bun:test';
import { InvalidArgumentError } from 'commander';

import { parseInteger } from '@/core/ui/parsing.ts';

describe('CLI option parsing', () => {
  it('should throw if not a valid number', () => {
    expect(() => parseInteger('x')).toThrow(new InvalidArgumentError('Not a number.'));
  });

  it('should successfully parse a valid number', () => {
    expect(parseInteger('42')).toBe(42);
  });
});
