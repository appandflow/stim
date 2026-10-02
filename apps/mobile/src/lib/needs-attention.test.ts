import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';

import fixture from '../../../desktop/Tests/StimKitTests/Fixtures/needs-attention-vectors.json';
import { messages } from '../../locales/en';

import { needsAttention, type NeedsAttentionInput, type NeedsAttentionItem } from '@/lib/needs-attention';

const vectors = fixture as unknown as {
  cases: { name: string; input: Omit<NeedsAttentionInput, 'now'> & { now: string }; items: NeedsAttentionItem[] }[];
};

describe('needsAttention', () => {
  afterEach(() => i18n.loadAndActivate({ locale: 'en', messages }));

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_, { input, items }) => {
    expect(needsAttention({ ...input, now: Date.parse(input.now) })).toEqual(items);
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
