/** @type {import('expo/fingerprint').Config} */
module.exports = {
  // @expo/fingerprint does not hash linked package sources, so native edits would keep the runtime version.
  extraSources: [
    { type: 'dir', filePath: 'modules/stim-session', reasons: ['nitroModule'] },
    { type: 'dir', filePath: '../../patches', reasons: ['patches'] },
  ],
  // The fetched libsodium sources; libsodium.json, which pins them, is hashed with the module.
  ignorePaths: ['modules/stim-session/third_party/**'],
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
