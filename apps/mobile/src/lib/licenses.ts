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

export const LICENSES: LicensePackage[] = packages.map((entry) => ({
  ...entry,
  text: entry.text === null ? null : texts[entry.text],
}));
