import { i18n } from '@lingui/core';

import { messages } from '../../locales/en';

/**
 * Messages are English only for now. Dates and numbers follow the device's region, as `toLocaleString()` did before
 * the app had catalogs; `en` backs it for the plural rules, which ship English data only.
 */
i18n.loadAndActivate({
  locale: 'en',
  locales: [Intl.DateTimeFormat().resolvedOptions().locale, 'en'],
  messages,
});
