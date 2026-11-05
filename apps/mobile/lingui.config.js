const { formatter } = require('@lingui/format-po');

module.exports = {
  sourceLocale: 'en',
  locales: ['en'],
  catalogs: [{ path: '<rootDir>/locales/{locale}', include: ['<rootDir>/src'] }],
  format: formatter({ lineNumbers: false }),
  compileNamespace: 'ts',
};
