export interface GcSkip {
  dir: string;
  reason: string;
}

export interface OrphanedDevice {
  orphanedDirectory?: import('./android.ts').OrphanedAvdDirectory;
  kind: 'ios' | 'android';
  id: string;
  name: string;
  bytes?: number;
}
