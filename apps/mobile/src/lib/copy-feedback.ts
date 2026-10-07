export const COPIED_MS = 2000;

/** Holds "copied" for `delay` ms after each `start`. A repeat `start` restarts the wait, so only one is ever pending. */
export function createCopyFeedback(onChange: (copied: boolean) => void, delay = COPIED_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    start() {
      clearTimeout(timer);
      onChange(true);
      timer = setTimeout(() => {
        timer = undefined;
        onChange(false);
      }, delay);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
