import { launchErrorReport } from '../command-output.ts';
import { parseLogcatLine } from '../collector/android.ts';
import { parseLogStreamLine } from '../collector/ios.ts';

test('device JavaScript failures remain visible without a client or Metro copy', () => {
  const android = parseLogcatLine('09-08 15:00:00.000 E/ReactNativeJS( 123): startup failed');
  const ios = parseLogStreamLine(
    JSON.stringify({
      eventType: 'logEvent',
      messageType: 'Error',
      eventMessage: 'startup failed',
      subsystem: 'com.facebook.react.log',
      category: 'javascript',
    }),
  );
  expect(launchErrorReport([{ ...android, platform: 'android' }]).lines).toEqual(['startup failed']);
  expect(launchErrorReport([{ ...ios, platform: 'ios' }]).lines).toEqual(['startup failed']);
});
