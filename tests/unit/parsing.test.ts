import { describe, expect, it } from 'bun:test';
import { parseInteger } from '../../src/cli/commands/_common/parsing';
import { InvalidOptionError } from '../../src/cli/commands/_common/error';

describe('CLI option parsing', () => {
  it('should throw if not a valid number', () => {
    expect(() => parseInteger('x')).toThrow(new InvalidOptionError('Not a number.'));
  });

  it('should successfully parse a valid number', () => {
    expect(parseInteger('42')).toBe(42);
  });
});
