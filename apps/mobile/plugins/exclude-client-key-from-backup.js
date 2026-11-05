const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

/**
 * The phone's Noise key sits in shared preferences (stim.noise.xml), encrypted with an Android Keystore key that
 * Auto Backup does not carry, so a restored copy cannot be decrypted. These rules replace expo-secure-store's,
 * which exclude only SecureStore.
 */
const EXCLUDES = ['SecureStore', 'stim.noise.xml'];
const rules = (indent) =>
  [
    `${indent}<include domain="sharedpref" path="."/>`,
    ...EXCLUDES.map((path) => `${indent}<exclude domain="sharedpref" path="${path}"/>`),
  ].join('\n');

const BACKUP = `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
${rules('  ')}
</full-backup-content>
`;
const EXTRACTION = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
${rules('    ')}
  </cloud-backup>
  <device-transfer>
${rules('    ')}
  </device-transfer>
</data-extraction-rules>
`;

module.exports = (config) =>
  withAndroidManifest(
    withDangerousMod(config, [
      'android',
      (mod) => {
        const dir = join(mod.modRequest.platformProjectRoot, 'app/src/main/res/xml');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'stim_backup_rules.xml'), BACKUP);
        writeFileSync(join(dir, 'stim_data_extraction_rules.xml'), EXTRACTION);
        return mod;
      },
    ]),
    (mod) => {
      const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
      application.$['android:fullBackupContent'] = '@xml/stim_backup_rules';
      application.$['android:dataExtractionRules'] = '@xml/stim_data_extraction_rules';
      return mod;
    },
  );
