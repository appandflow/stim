import type { EvalCase } from '../types.ts';
import { firstLaunch } from './first-launch.ts';
import { freeDisk } from './free-disk.ts';
import { refusal } from './refusal.ts';

export const CASES: EvalCase[] = [firstLaunch, refusal, freeDisk];
