// vitest.setup.ts imports this before any test file's own module mocks are registered. Keep it free of other
// imports so loading it cannot pre-populate the module cache.
export const HOME_PASSES_TEST_GUARD_ENV = 'STIM_TEST_GUARD_NO_HOME_PASSES';
