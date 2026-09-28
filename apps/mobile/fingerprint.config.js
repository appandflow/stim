/** @type {import('expo/fingerprint').Config} */
module.exports = {
  // @expo/fingerprint does not hash inline module sources, so native edits would keep the runtime version.
  extraSources: [
    { type: 'dir', filePath: 'modules/stim-video/ios', reasons: ['inlineModules'] },
    { type: 'dir', filePath: 'modules/stim-video/android', reasons: ['inlineModules'] },
    { type: 'dir', filePath: '../../patches', reasons: ['patches'] },
  ],
  // Setting sourceSkips replaces the 'balanced' preset's defaults instead of adding to them, so list
  // those defaults alongside PackageJsonScriptsAll. package.json scripts don't affect the native
  // build; hashing them bumped the runtime version and broke OTA compatibility (stim#1814).
  sourceSkips: [
    'PackageJsonAndroidAndIosScriptsIfNotContainRun',
    'ExpoConfigVersions',
    'ExpoConfigRuntimeVersionIfString',
    'EasJson',
    'Easignore',
    'AutolinkingConfigPaths',
    'PackageJsonScriptsAll',
  ],
};
