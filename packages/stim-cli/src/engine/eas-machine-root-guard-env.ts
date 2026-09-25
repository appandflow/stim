// vitest.setup.ts imports this before any test file's own module mocks (for
// example node:fs) are registered. Keep it free of other imports so loading
// it cannot pre-populate the module cache with an unmocked built-in.
export const EAS_TEST_GUARD_ROOT_ENV = 'STIM_TEST_GUARD_REAL_EAS_ROOT';
