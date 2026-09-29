import 'react-native-unistyles/mocks';
import 'react-native-gesture-handler/jestSetup';

import { act, fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import '@/design/unistyles';

import { StageLine } from './workspace-cards';

const STAGE = { label: 'Running' as const, tone: 'success' as const, subtitle: 'up 8m' };
const GIT = {
  parts: [{ text: '7 changed', tone: 'default' as const }],
  pr: null,
  label: 'merged into origin/main',
};

const layoutEvent = (y: number) => ({ nativeEvent: { layout: { x: 0, y, width: 0, height: 0 } } });

async function renderStageLine() {
  const utils = await render(<StageLine stage={STAGE} git={GIT} onGitPress={() => {}} />);
  return { ...utils, stageGroup: utils.getByTestId('stage-group'), chipGroup: utils.getByTestId('chip-group') };
}

test('the divider keeps the same width and gap whether or not the chip group has wrapped', async () => {
  const { stageGroup, chipGroup, getByTestId } = await renderStageLine();

  await act(async () => fireEvent(stageGroup, 'layout', layoutEvent(0)));
  await act(async () => fireEvent(chipGroup, 'layout', layoutEvent(0)));
  const notWrapped = StyleSheet.flatten(getByTestId('stage-divider').props.style);

  await act(async () => fireEvent(chipGroup, 'layout', layoutEvent(20)));
  const wrapped = StyleSheet.flatten(getByTestId('stage-divider').props.style);

  expect(wrapped.width).toEqual(notWrapped.width);
  expect(wrapped.height).toEqual(notWrapped.height);
  expect(wrapped.backgroundColor).not.toEqual(notWrapped.backgroundColor);
});
