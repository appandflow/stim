/**
 * The integer of the operation names and options `runOp` receives from another Stim build. It changes only when one is
 * removed, renamed or changes meaning; a build that loads an engine speaking another integer refuses the operation.
 */
export const RUN_OP_VERSION = 1 as const;
