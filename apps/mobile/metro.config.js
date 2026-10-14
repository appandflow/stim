const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname);

// The libsodium C sources modules/stim-session/scripts/fetch-libsodium.mjs extracts; nothing in them is JavaScript.
const blockList = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(blockList) ? blockList : blockList ? [blockList] : []),
  /[/\\]modules[/\\]stim-session[/\\]third_party[/\\].*/,
];

module.exports = config;
