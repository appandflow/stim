import 'react-native-unistyles/mocks';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render } from '@testing-library/react-native';

import '@/design/unistyles';

import { HostLabel } from './host-label';

it.each([
  ['running', 'Running on mini'],
  ['building', 'Building on mini'],
  ['placed', 'On mini'],
] as const)('speaks a %s placement as "%s" and shows only the name', async (mode, spoken) => {
  const screen = await render(
    <I18nProvider i18n={i18n}>
      <HostLabel host="mini" mode={mode} />
    </I18nProvider>,
  );
  expect(screen.getByLabelText(spoken)).toBeTruthy();
  expect(screen.getByText('mini')).toBeTruthy();
});
