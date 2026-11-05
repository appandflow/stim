import { i18n } from '@lingui/core';

import { messages } from '../../locales/en';

/** Messages are English only for now. Dates follow the device's region; `en` backs the English-only plural rules. */
i18n.loadAndActivate({
  locale: 'en',
  locales: [Intl.DateTimeFormat().resolvedOptions().locale, 'en'],
  messages,
});
