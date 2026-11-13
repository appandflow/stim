import { parseGroupListing } from '../stimd/metro/group-stop.ts';

test('a ps listing from procps or BSD ps yields the running and zombie members of one group', () => {
  const linux = [
    '    1     1 Ss',
    ' 4242  4242 Ss+',
    ' 4243  4242 S<l',
    '4244 4242 Z',
    ' 4245  4242 R+',
    ' 4300  4300 Ssl',
  ].join('\n');
  expect(parseGroupListing(linux, 4242)).toEqual([
    { pid: 4242, zombie: false },
    { pid: 4243, zombie: false },
    { pid: 4244, zombie: true },
    { pid: 4245, zombie: false },
  ]);
  const darwin = ['  4242  4242 Ss', '  4243  4242 S+', '  4244  4242 Z+', '  4246  4246 Ss'].join('\n');
  expect(parseGroupListing(darwin, 4242)).toEqual([
    { pid: 4242, zombie: false },
    { pid: 4243, zombie: false },
    { pid: 4244, zombie: true },
  ]);
  expect(parseGroupListing('PID PGID STAT\nnot a row\n', 4242)).toEqual([]);
});
