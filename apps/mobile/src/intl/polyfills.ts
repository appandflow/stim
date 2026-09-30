// Hermes has no Intl.PluralRules, which Lingui's plural() needs, nor the Intl.Locale its polyfill's locale matching
// needs. Each polyfill installs itself only when the API is missing.
import '@formatjs/intl-locale/polyfill.js';
import '@formatjs/intl-pluralrules/polyfill.js';
import '@formatjs/intl-pluralrules/locale-data/en.js';
