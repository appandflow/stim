export class RecordedDeviceLostError extends Error {
  readonly code = 'STIM_DEVICE_LOST';
  readonly remedy: string;
  constructor(platform: string, expected: string, why: string) {
    super(
      `${platform === 'ios' ? 'Simulator' : 'Emulator'} ${expected} ${why}, and this run may not create or adopt another device.`,
    );
    this.remedy = `Run \`stim ${platform}\` (with \`--slot\` for a named slot); it boots or creates this workspace's owned device and launches the app.`;
  }
}
