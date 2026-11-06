const unit =
  /^(?:packages\/[^/]+\/(?:src\/|__tests__\/).+\.test\.ts|scripts\/.+\.test\.mjs|website\/scripts\/.+\.test\.mjs|website\/src\/.+\.test\.ts|\.github\/actions\/stim-ci\/src\/.+\.test\.ts)$/;

export function isUnitTestFile(file) {
  return unit.test(file) && !/\.(?:compat|browser)\.test\.ts$/.test(file);
}
