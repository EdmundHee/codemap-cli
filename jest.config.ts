import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  moduleNameMapper: {
    '^@core/(.*)$': '<rootDir>/src/core/$1',
    '^@parsers/(.*)$': '<rootDir>/src/parsers/$1',
    '^@analyzers/(.*)$': '<rootDir>/src/analyzers/$1',
    '^@frameworks/(.*)$': '<rootDir>/src/frameworks/$1',
    '^@output/(.*)$': '<rootDir>/src/output/$1',
    '^@utils/(.*)$': '<rootDir>/src/utils/$1',
  },
};

export default config;
