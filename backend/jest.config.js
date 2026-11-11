module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
    // jose 6 ships ES modules only. Node 24 loads it with `require` at runtime,
    // but jest keeps its own module registry and cannot, so its files are
    // compiled to CommonJS here, for the tests alone.
    '^.+[\\\\/]node_modules[\\\\/]jose[\\\\/].+\\.js$': [
      'ts-jest',
      { tsconfig: { allowJs: true, module: 'CommonJS', target: 'ES2022' } },
    ],
  },
  transformIgnorePatterns: ['[\\\\/]node_modules[\\\\/](?!jose[\\\\/])'],
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts'],
  coverageDirectory: 'coverage',
  testEnvironment: 'node',
};
