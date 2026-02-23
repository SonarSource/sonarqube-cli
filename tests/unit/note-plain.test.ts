// Tests for note() renderPlain path (non-TTY, no mock)
// mock.module forces isTTY: false so renderPlain executes regardless of terminal

import { describe, it, expect, spyOn } from 'bun:test';

mock.module('../../src/ui/colors.js', () => ({
  isTTY: false,
  bold:  (s: string) => s,
  dim:   (s: string) => s,
  green: (s: string) => s,
  red:   (s: string) => s,
  cyan:  (s: string) => s,
  yellow:(s: string) => s,
  gray:  (s: string) => s,
  white: (s: string) => s,
}));

import { mock } from 'bun:test';
import { note } from '../../src/ui/components/note.js';

describe('note: renderPlain (non-TTY)', () => {
  it('writes content to stdout without box characters', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      note('some content');
      const combined = output.join('');
      expect(combined).toContain('some content');
      expect(combined).not.toContain('┌');
      expect(combined).not.toContain('└');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('includes title in brackets when provided', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      note('content line', 'My Title');
      const combined = output.join('');
      expect(combined).toContain('[My Title]');
      expect(combined).toContain('content line');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('omits header when no title given', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      note('just content');
      const combined = output.join('');
      expect(combined).not.toContain('[');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('renders each line of array content separately', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      note(['line one', 'line two']);
      const combined = output.join('');
      expect(combined).toContain('line one');
      expect(combined).toContain('line two');
    } finally {
      writeSpy.mockRestore();
    }
  });
});
