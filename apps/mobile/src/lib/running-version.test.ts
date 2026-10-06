import { runningVersion } from '@/lib/running-version';

const app = {
  version: '1.0.0',
  build: '22',
  updateId: '1a2b3c4d-5678-1234-1234-123456789abc',
  createdAt: new Date('2026-10-05T12:00:00Z'),
  isEmbeddedLaunch: false,
};

it('shows the app build and the running OTA with its short id and publication date', () => {
  expect(runningVersion(app)).toEqual({
    version: 'Stim 1.0.0 (22)',
    update: 'Update 1a2b3c4d, Oct 5, 2026',
  });
});

it('omits the build when unavailable', () => {
  expect(runningVersion({ ...app, build: null }).version).toBe('Stim 1.0.0');
});

it('identifies an embedded launch even when it has an update id', () => {
  expect(runningVersion({ ...app, isEmbeddedLaunch: true }).update).toBe('Built-in');
});

it('identifies a launch without an update id as built-in', () => {
  expect(runningVersion({ ...app, updateId: null }).update).toBe('Built-in');
});

it('omits the publication date when unavailable', () => {
  expect(runningVersion({ ...app, createdAt: null }).update).toBe('Update 1a2b3c4d');
});
