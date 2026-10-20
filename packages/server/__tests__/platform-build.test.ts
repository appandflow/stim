import Ajv2020 from 'ajv/dist/2020.js';
import { parsePlatformBuild } from '../src/platform-build.ts';
import { protocolJsonSchema, type PlatformBuildOptions } from '../src/protocol.ts';

const validator = new Ajv2020({ strict: false, validateFormats: false });
validator.addSchema(protocolJsonSchema(), 'protocol');
const accepts = validator.compile({ $ref: 'protocol#/$defs/ClientRequest' });

test.each<PlatformBuildOptions>([
  { platform: 'ios', arch: 'arm64', configuration: 'Debug', scheme: 'Example', buildCache: false, remoteBuild: 'mini' },
  { platform: 'ios', arch: 'x86_64' },
  { platform: 'ios', arch: 'all' },
  { platform: 'android', abi: 'arm64-v8a', variant: 'demoDebug', buildCache: true, remoteBuild: 'local' },
  { platform: 'android', abi: 'armeabi-v7a' },
  { platform: 'android', abi: 'x86' },
  { platform: 'android', abi: 'x86_64' },
  { platform: 'android', abi: 'all' },
  { platform: 'macos', remoteBuild: 'auto' },
])('preserves supported build selectors through the parser and wire schema: %j', (options) => {
  const cwd = process.cwd();
  const params = { cwd, options };
  expect(parsePlatformBuild(params)).toEqual(params);
  expect(accepts({ id: 1, method: 'desktop.build.subscribe', params })).toBe(true);
});
