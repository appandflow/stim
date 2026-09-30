import data from '@/generated/licenses.json';

export interface LicensePackage {
  name: string;
  version: string;
  license: string;
  url: string | null;
  text: string | null;
}

interface LicenseData {
  packages: (Omit<LicensePackage, 'text'> & { text: number | null })[];
  texts: string[];
}

const { packages, texts } = data as LicenseData;

/** Stim first, then every npm package in the app's JS bundle or linked natively, from `pnpm run licenses`. */
export const LICENSES: LicensePackage[] = packages.map((entry) => ({
  ...entry,
  text: entry.text === null ? null : texts[entry.text],
}));
