import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';

import fixture from '../../../desktop/Tests/StimKitTests/Fixtures/needs-attention-vectors.json';
import { messages } from '../../locales/en';

import { needsAttention, type NeedsAttentionInput } from '@/lib/needs-attention';

const vectors = fixture as unknown as {
  cases: { name: string; input: Omit<NeedsAttentionInput, 'now'> & { now: string } }[];
};

describe('needsAttention', () => {
  afterEach(() => i18n.loadAndActivate({ locale: 'en', messages }));

  it.each([
    {
      name: 'names the signing platform and refusal code',
      fixture: 'keeps signing and provisioning failures for a day or while live, not refusals an agent retries',
      id: 'run-ios:/w/sign',
      details: ['iOS', 'STIM_CODESIGN_FAILED'],
    },
    {
      name: 'identifies the issue slot and affected device',
      fixture: 'keeps a port held by another app and processes Stim cannot verify',
      id: 'issue-avd-unchecked-tablet:/w/a',
      details: ['tablet', 'stim-b', 'adb timed out'],
    },
    {
      name: 'identifies the leased physical device',
      fixture: 'keeps an expired lease',
      id: 'lease-android-default:/w/a',
      details: ['Pixel 9'],
    },
    {
      name: 'reports how long the unattended billable EAS session ran',
      fixture: 'keeps a billable EAS session nobody drives',
      id: 'eas-s-1:/w/left',
      details: ['EAS', /\b45\b/, 'min'],
    },
    {
      name: 'identifies the stuck device, elapsed inactivity and last green platform',
      fixture: 'keeps an agent that went quiet past the stuck threshold',
      id: 'stuck:/w/stuck',
      details: [/\b20\b/, 'min', 'iOS', 'iPhone 17 Pro 26.0'],
    },
    {
      name: 'identifies the repeated build failure platform, count and code',
      fixture: 'forgets an idle repeated failure after a day, not a live one',
      id: 'looping-ios:/w/old-live',
      details: ['iOS', /\b3(?:x)?\b/, 'STIM_BUILD_FAILED'],
    },
  ])('$name', ({ fixture, id, details }) => {
    const { input } = vectors.cases.find((entry) => entry.name === fixture)!;
    const environments = input.environments.map((environment) => ({
      ...environment,
      issues: environment.issues?.map((issue) =>
        issue.code === 'avd-unchecked' ? { ...issue, slot: 'tablet' } : issue,
      ),
    }));
    const item = needsAttention({ ...input, environments, now: Date.parse(input.now) }).find((item) => item.id === id);
    for (const detail of details) {
      if (detail instanceof RegExp) expect(item?.body).toMatch(detail);
      else expect(item?.body).toContain(detail);
    }
  });

  it('localizes selected messages and decimal sizes without changing the items', () => {
    const { input } = vectors.cases.find((entry) => entry.name === 'keeps the same failure three times in a row')!;
    const selected = { ...input, now: Date.parse(input.now), volumes: [{ freeBytes: 3.25e9 }] };
    const english = needsAttention(selected);
    i18n.loadAndActivate({
      locale: 'fr',
      messages: {
        ...messages,
        [msg({ message: '{gb} GB' }).id]: [['gb'], ' Go'],
        [msg({ message: "{free} free, below Stim's floor" }).id]: [['free'], ' libres, sous le seuil de Stim'],
        [msg({ message: 'Same {language} error {count}x at {file}:{line}' }).id]: [
          'Meme erreur ',
          ['language'],
          ' ',
          ['count'],
          'x dans ',
          ['file'],
          ':',
          ['line'],
        ],
      },
    });
    const localized = needsAttention(selected);
    expect(localized).toEqual(english.map((item, index) => ({ ...item, body: localized[index]!.body })));
    expect(localized.map((item) => item.body)).toEqual([
      '3,3 Go libres, sous le seuil de Stim',
      'Meme erreur Swift 3x dans AppDelegate.swift:71',
      'App failed to launch on Android 4x in a row',
    ]);
  });
});
