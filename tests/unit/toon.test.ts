// TOON formatter tests using official @toon-format/toon library

import { it, expect } from 'bun:test';

import { encodeToToon } from '../../src/formatter/toon.js';

it('toon: primitives', () => {
  expect(encodeToToon(null)).toBe('null');
  expect(encodeToToon(true)).toBe('true');
  expect(encodeToToon(false)).toBe('false');
  expect(encodeToToon(0)).toBe('0');
  expect(encodeToToon(42)).toBe('42');
  expect(encodeToToon(-17)).toBe('-17');
  expect(encodeToToon(3.14)).toBe('3.14');
});

it('toon: strings', () => {
  // Simple strings (no quotes needed)
  expect(encodeToToon('hello')).toBe('hello');

  // Empty string needs quotes
  expect(encodeToToon('')).toBe('""');

  // String with spaces - official library doesn't add quotes unless necessary
  const withSpaces = encodeToToon('hello world');
  expect(withSpaces.includes('hello')).toBe(true);
  expect(withSpaces.includes('world')).toBe(true);
});

it('toon: strings that look like keywords or numbers', () => {
  // Strings that look like keywords need quotes
  expect(encodeToToon('true')).toBe('"true"');
  expect(encodeToToon('false')).toBe('"false"');
  expect(encodeToToon('null')).toBe('"null"');

  // Strings that look like numbers need quotes
  expect(encodeToToon('123')).toBe('"123"');
});

it('toon: empty object and array', () => {
  // Official library returns empty string for empty objects
  const emptyObj = encodeToToon({});
  expect(emptyObj === '' || emptyObj === '{}').toBe(true);

  // Official library returns '[0]:' for empty arrays (array with 0 elements)
  const emptyArr = encodeToToon([]);
  expect(emptyArr).toBe('[0]:');
});

it('toon: simple object', () => {
  const obj = { name: 'John', age: 30 };
  const result = encodeToToon(obj);

  // Official format: name: John\nage: 30
  expect(result.includes('name:')).toBe(true);
  expect(result.includes('John')).toBe(true);
  expect(result.includes('age:')).toBe(true);
  expect(result.includes('30')).toBe(true);
});

it('toon: nested object', () => {
  const obj = {
    user: {
      name: 'Alice',
      email: 'alice@example.com'
    }
  };

  const result = encodeToToon(obj);

  expect(result.includes('user:')).toBe(true);
  expect(result.includes('name:')).toBe(true);
  expect(result.includes('Alice')).toBe(true);
  expect(result.includes('email:')).toBe(true);
  expect(result.includes('alice@example.com')).toBe(true);
});

it('toon: array of primitives (inline format)', () => {
  const arr = [1, 2, 3, 4, 5];
  const result = encodeToToon(arr);

  // Official format: [5]: 1,2,3,4,5
  expect(result.includes('[5]')).toBe(true);
  expect(result.includes('1')).toBe(true);
  expect(result.includes('5')).toBe(true);
});

it('toon: array of strings (inline format)', () => {
  const arr = ['apple', 'banana', 'cherry'];
  const result = encodeToToon(arr);

  // Official format: [3]: apple,banana,cherry
  expect(result.includes('[3]')).toBe(true);
  expect(result.includes('apple')).toBe(true);
  expect(result.includes('banana')).toBe(true);
  expect(result.includes('cherry')).toBe(true);
});

it('toon: tabular array (uniform objects)', () => {
  const arr = [
    { name: 'Alice', age: 30 },
    { name: 'Bob', age: 25 },
    { name: 'Charlie', age: 35 }
  ];

  const result = encodeToToon(arr);

  // Official format uses tabular representation
  // [3]{name,age}:
  //   Alice,30
  //   Bob,25
  //   Charlie,35
  expect(result.includes('[3]')).toBe(true);
  expect(result.includes('name')).toBe(true);
  expect(result.includes('age')).toBe(true);
  expect(result.includes('Alice')).toBe(true);
  expect(result.includes('30')).toBe(true);
  expect(result.includes('Bob')).toBe(true);
  expect(result.includes('25')).toBe(true);
  expect(result.includes('Charlie')).toBe(true);
  expect(result.includes('35')).toBe(true);
});

it('toon: complex nested structure', () => {
  const data = {
    project: 'my-project',
    issues: [
      {
        severity: 'MAJOR',
        rule: 'java:S1234',
        message: 'Issue description'
      },
      {
        severity: 'MINOR',
        rule: 'java:S5678',
        message: 'Another issue'
      }
    ],
    metadata: {
      total: 2,
      timestamp: '2024-01-01'
    }
  };

  const result = encodeToToon(data);

  // Verify all data is present
  expect(result.includes('project:')).toBe(true);
  expect(result.includes('my-project')).toBe(true);
  expect(result.includes('issues')).toBe(true);
  expect(result.includes('[2]')).toBe(true);
  expect(result.includes('MAJOR')).toBe(true);
  expect(result.includes('MINOR')).toBe(true);
  expect(result.includes('java:S1234')).toBe(true);
  expect(result.includes('java:S5678')).toBe(true);
  expect(result.includes('metadata:')).toBe(true);
  expect(result.includes('total:')).toBe(true);
  expect(result.includes('timestamp:')).toBe(true);
});

it('toon: SonarQube issues response (real-world example)', () => {
  const response = {
    total: 2,
    issues: [
      {
        key: 'AX123',
        rule: 'java:S1234',
        severity: 'MAJOR',
        component: 'com.example:MyClass.java',
        line: 42,
        message: 'Remove this unused variable',
        status: 'OPEN',
        type: 'CODE_SMELL'
      },
      {
        key: 'AX456',
        rule: 'java:S5678',
        severity: 'CRITICAL',
        component: 'com.example:AnotherClass.java',
        line: 10,
        message: 'Fix this security vulnerability',
        status: 'OPEN',
        type: 'VULNERABILITY'
      }
    ]
  };

  const result = encodeToToon(response);

  // Verify structure and data
  expect(result.includes('total:')).toBe(true);
  expect(result.includes('2')).toBe(true);
  expect(result.includes('issues')).toBe(true);
  expect(result.includes('[2]')).toBe(true);

  // Verify first issue
  expect(result.includes('AX123')).toBe(true);
  expect(result.includes('java:S1234')).toBe(true);
  expect(result.includes('MAJOR')).toBe(true);
  expect(result.includes('42')).toBe(true);
  expect(result.includes('Remove this unused variable')).toBe(true);

  // Verify second issue
  expect(result.includes('AX456')).toBe(true);
  expect(result.includes('java:S5678')).toBe(true);
  expect(result.includes('CRITICAL')).toBe(true);
  expect(result.includes('10')).toBe(true);
  expect(result.includes('Fix this security vulnerability')).toBe(true);
});

it('toon: numbers without trailing zeros', () => {
  // Official library should handle this automatically
  expect(encodeToToon(1.0)).toBe('1');
  expect(encodeToToon(2.5)).toBe('2.5');
  expect(encodeToToon(100.0)).toBe('100');
});

it('toon: special characters in strings', () => {
  const obj = {
    text: 'Line 1\nLine 2\tTabbed',
    quote: 'He said "hello"',
    backslash: 'Path\\to\\file'
  };

  const result = encodeToToon(obj);

  // The official library should handle escaping
  expect(result.length > 0).toBe(true);
  expect(result.includes('text:')).toBe(true);
  expect(result.includes('quote:')).toBe(true);
  expect(result.includes('backslash:')).toBe(true);
});

it('toon: encodes and produces valid output', () => {
  // Ensure basic encoding works
  const data = { foo: 'bar', baz: [1, 2, 3] };
  const result = encodeToToon(data);

  expect(result.length > 0).toBe(true);
  expect(result.includes('foo')).toBe(true);
  expect(result.includes('bar')).toBe(true);
  expect(result.includes('baz')).toBe(true);
});
