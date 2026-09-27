import { cdpClientTool, hostDriverTool, instrumentationTool } from '../devices/automation-tools.ts';

const UDID = 'C7C75397-162B-47A8-B43D-5025444D89DB';
const SERIAL = 'emulator-5554';
const ARGENT = '/Users/me/project/node_modules/@swmansion/argent';
const SIMCTL = '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl';

describe('host processes that name the device', () => {
  test.each<[string, 'ios' | 'android', string, string | null]>([
    [
      '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test-without-building -only-testing AgentDeviceRunnerUITests/RunnerTests/testCommand -xctestrun /Users/me/.agent-device/apple-runner/derived/ios-simulator/cache-54ec312d5fba03bd/Build/Products/AgentDeviceRunner.env.session-' +
        `${UDID}-owner-59297-8ffad543-52731.xctestrun -destination platform=iOS Simulator,id=${UDID}`,
      'ios',
      UDID,
      'agent-device',
    ],
    [
      `${SIMCTL} spawn ${UDID} /Users/me/.agent-device/snapshot-source/39d316d4ec27a1b3e990c13f86543bf7/snapshot-bridge serve /tmp/agent-device-ax-c9dead068972-59297-6bfee1763a53/snapshot.sock --idle-timeout 60`,
      'ios',
      UDID,
      'agent-device',
    ],
    [`${ARGENT}/bin/darwin/simulator-server ios --id ${UDID}`, 'ios', UDID, 'argent'],
    [
      `${SIMCTL} spawn ${UDID} ${ARGENT}/bin/darwin/ax-service --socket /tmp/ax-C7C75397.sock --timeout 3600`,
      'ios',
      UDID,
      'argent',
    ],
    [`${ARGENT}/bin/darwin/simulator-server android --id ${SERIAL}`, 'android', SERIAL, 'argent'],
    [
      `/opt/android-sdk/platform-tools/adb -s ${SERIAL} shell am instrument -w com.argent.androiddevtools/.SnapshotInstrumentation`,
      'android',
      SERIAL,
      'argent',
    ],
    [`/usr/local/bin/idb_companion --udid ${UDID} --grpc-port 10882`, 'ios', UDID, 'idb'],
    [`maestro test flow.yaml --udid ${UDID}`, 'ios', UDID, 'maestro'],
    [
      `/usr/bin/java -jar /Users/me/.maestro/lib/maestro-cli.jar test flow.yaml --device ${SERIAL}`,
      'android',
      SERIAL,
      'maestro',
    ],
    [
      `/usr/bin/xcodebuild build-for-testing test-without-building -project /Users/me/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination id=${UDID}`,
      'ios',
      UDID,
      'appium',
    ],
    [
      `/usr/bin/xcodebuild test -project /Users/me/argent-app/App.xcodeproj -scheme App -destination platform=iOS Simulator,id=${UDID}`,
      'ios',
      UDID,
      'xcodebuild',
    ],
    [`/usr/bin/xcrun simctl io ${UDID} recordVideo /tmp/out.mov`, 'ios', UDID, 'simctl'],
    [`/Users/me/.stim/server/helpers/stim-frames-273911f80b7da90a ios ${UDID}`, 'ios', UDID, null],
    [`/usr/local/bin/idb_companion --udid ${SERIAL}`, 'android', SERIAL, null],
    [`${ARGENT}/bin/darwin/simulator-server ios --id ${UDID}`, 'ios', '8D2F4C2E-0000-4000-8000-000000000000', null],
  ])('%s', (command, platform, id, tool) => {
    expect(hostDriverTool(command, platform, id)).toBe(tool);
  });
});

describe('on-device Android processes', () => {
  test.each<[string, string | null]>([
    ['uiautomator', 'uiautomator'],
    ['cmd activity instrument -w com.argent.androiddevtools/.SnapshotInstrumentation', 'argent'],
    ['com.argent.androiddevtools', 'argent'],
    ['app_process /system/bin com.android.commands.uiautomator.Launcher runtest', 'uiautomator'],
    ['am instrument -w dev.mobile.maestro.test/androidx.test.runner.AndroidJUnitRunner', 'instrumentation'],
    ['dev.mobile.maestro.test', null],
    ['/system/bin/surfaceflinger', null],
  ])('%s', (args, tool) => {
    expect(instrumentationTool(args)).toBe(tool);
  });
});

describe('DevTools clients of the owned Chrome', () => {
  test.each<[string, string | null]>([
    ['node /Users/me/.npm/_npx/1/node_modules/.bin/agent-browser --cdp 9391', 'agent-browser'],
    ['node /Users/me/.local/lib/node_modules/agent-device/dist/src/internal/daemon.js', 'agent-device'],
    [`node ${ARGENT}/dist/tool-server.cjs start`, 'argent'],
    [
      'node /Users/me/.npm/_npx/2/node_modules/.bin/chrome-devtools-mcp --browserUrl http://127.0.0.1:9391',
      'chrome-devtools-mcp',
    ],
    ['node /Users/me/.npm/_npx/9833c18b2d85bc59/node_modules/.bin/playwright-mcp', 'playwright'],
    ['node /Users/me/app/node_modules/puppeteer-core/lib/cjs/puppeteer/node/cli.js', 'puppeteer'],
    ['node /Users/me/scripts/drive.mjs --port 9391', 'drive.mjs'],
    ['/usr/local/bin/websocat ws://127.0.0.1:9391/devtools/page/1', 'websocat'],
    ['stim-web', null],
    ['/Users/me/.stim/server/helpers/stim-frames-0123456789abcdef web http://127.0.0.1:9391 77807 ABC', null],
    ['/Applications/Stim.app/Contents/MacOS/StimDesktop', null],
    ['node /Users/me/.local/lib/node_modules/stim/dist/cli.mjs status --json', null],
  ])('%s', (command, tool) => {
    expect(cdpClientTool(command)).toBe(tool);
  });
});
