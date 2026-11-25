import type { EvalCase } from '../types.ts';
import { deviceSigning } from './device-signing.ts';
import { firstLaunch } from './first-launch.ts';
import { freeDisk } from './free-disk.ts';
import { ownDevice } from './own-device.ts';
import { refusal } from './refusal.ts';
import { removeWorktree } from './remove-worktree.ts';
import { runtimeError } from './runtime-error.ts';
import { verifyAndStop } from './verify-and-stop.ts';
import { WEBSITE_CASES } from './website-prompts.ts';

export const CASES: EvalCase[] = [
  firstLaunch,
  refusal,
  freeDisk,
  runtimeError,
  deviceSigning,
  ownDevice,
  verifyAndStop,
  removeWorktree,
  ...WEBSITE_CASES,
];
