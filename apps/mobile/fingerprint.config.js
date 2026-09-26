/** @type {import('expo/fingerprint').Config} */
module.exports = {
  // @expo/fingerprint does not hash inline module sources, so native edits would keep the runtime version.
  extraSources: [
    { type: 'dir', filePath: 'modules/stim-video/ios', reasons: ['inlineModules'] },
    { type: 'dir', filePath: 'modules/stim-video/android', reasons: ['inlineModules'] },
  ],
};
