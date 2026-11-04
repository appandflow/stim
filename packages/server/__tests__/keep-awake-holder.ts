import { ChildProcess } from 'node:child_process';

/** Stands in for the `caffeinate` process: records whether it was asked to stop and never starts anything. */
export class FakeHolder extends ChildProcess {
  stopped = false;
  constructor(pid: number | undefined) {
    super();
    Object.defineProperty(this, 'pid', { value: pid });
  }
  override kill(): boolean {
    this.stopped = true;
    return true;
  }
}
