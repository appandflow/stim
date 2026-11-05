const { withAppBuildGradle, withDangerousMod } = require('expo/config-plugins');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SKIP_IOS = 'if [ -z "$SENTRY_AUTH_TOKEN" ]; then export SENTRY_DISABLE_AUTO_UPLOAD=true; fi';
const SKIP_ANDROID =
  'project.ext.shouldSentryAutoUploadGeneral = { -> System.getenv("SENTRY_DISABLE_AUTO_UPLOAD") != "true" && !!System.getenv("SENTRY_AUTH_TOKEN") }';

const append = (contents, line) => (contents.includes(line) ? contents : `${contents.trimEnd()}\n\n${line}\n`);

/** Sentry's build steps fail a Release build that cannot upload; without SENTRY_AUTH_TOKEN they skip the upload. */
module.exports = (config) =>
  withAppBuildGradle(
    withDangerousMod(config, [
      'ios',
      (mod) => {
        const file = join(mod.modRequest.platformProjectRoot, '.xcode.env');
        writeFileSync(file, append(readFileSync(file, 'utf8'), SKIP_IOS));
        return mod;
      },
    ]),
    (mod) => {
      mod.modResults.contents = append(mod.modResults.contents, SKIP_ANDROID);
      return mod;
    },
  );
