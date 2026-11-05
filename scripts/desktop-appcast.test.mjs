import { mergeAppcast, parseItems } from './desktop-appcast.mjs';

const link = 'https://example.test/appcast.xml';
function item(version, build, channel) {
  return `<item>
  <title>${version}</title>
  <sparkle:version>${build}</sparkle:version>
  <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
  ${channel ? `<sparkle:channel>${channel}</sparkle:channel>` : ''}
  <enclosure url="https://example.test/Stim-${version}.zip" length="1" type="application/octet-stream" sparkle:edSignature="sig"/>
</item>`;
}
const summary = (xml) => parseItems(xml).map((entry) => `${entry.channel || 'stable'} ${entry.version} ${entry.build}`);

test('a next item joins the appcast without touching the stable item', () => {
  const stable = mergeAppcast({ item: item('0.2.16', 1000), link });
  const merged = mergeAppcast({ current: stable, item: item('0.3.0-next.1.gaaaaaaa', 1010, 'next'), link });
  expect(summary(merged)).toEqual(['stable 0.2.16 1000', 'next 0.3.0-next.1.gaaaaaaa 1010']);
  expect(merged).toContain('<sparkle:channel>next</sparkle:channel>');
});

test('the appcast keeps only the newest next items', () => {
  let xml = mergeAppcast({ item: item('0.2.16', 1000), link });
  for (let n = 1; n <= 7; n++) {
    xml = mergeAppcast({ current: xml, item: item(`0.3.0-next.${n}.gaaaaaa${n}`, 1000 + n, 'next'), link, keep: 3 });
  }
  expect(summary(xml)).toEqual([
    'stable 0.2.16 1000',
    'next 0.3.0-next.7.gaaaaaa7 1007',
    'next 0.3.0-next.6.gaaaaaa6 1006',
    'next 0.3.0-next.5.gaaaaaa5 1005',
  ]);
});

test('a stable release replaces the stable item and drops next items it supersedes', () => {
  let xml = mergeAppcast({ item: item('0.2.16', 1000), link });
  xml = mergeAppcast({ current: xml, item: item('0.3.0-next.1.gaaaaaaa', 1010, 'next'), link });
  xml = mergeAppcast({ current: xml, item: item('0.3.0-next.2.gbbbbbbb', 1030, 'next'), link });
  xml = mergeAppcast({ current: xml, item: item('0.3.0', 1020), link });
  expect(summary(xml)).toEqual(['stable 0.3.0 1020', 'next 0.3.0-next.2.gbbbbbbb 1030']);
});

test('republishing a version replaces its item, and an older stable never replaces a newer one', () => {
  let xml = mergeAppcast({ item: item('0.3.0', 1020), link });
  xml = mergeAppcast({ current: xml, item: item('0.2.9', 900), link });
  expect(summary(xml)).toEqual(['stable 0.3.0 1020']);
  xml = mergeAppcast({ current: xml, item: item('0.4.0-next.1.gaaaaaaa', 1100, 'next'), link });
  xml = mergeAppcast({ current: xml, item: item('0.4.0-next.1.gaaaaaaa', 1100, 'next'), link });
  expect(summary(xml)).toEqual(['stable 0.3.0 1020', 'next 0.4.0-next.1.gaaaaaaa 1100']);
});

test('an item without a numeric build or with an unknown channel is refused', () => {
  expect(() => mergeAppcast({ item: item('0.3.0', 'abc'), link })).toThrow(/integer sparkle:version/);
  expect(() => mergeAppcast({ item: item('0.3.0', 1, 'beta'), link })).toThrow(/Unknown Sparkle channel/);
});
