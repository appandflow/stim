if (__DEV__) console.info('[stim:readiness] pending');

let macsLoaded = false;
let splashDismissed = false;
let reported = false;

function reportWhenUsable() {
  if (reported || !macsLoaded || !splashDismissed) return;
  reported = true;
  if (__DEV__) console.info('[stim:readiness] ready');
}

export function markMacsLoaded() {
  macsLoaded = true;
  reportWhenUsable();
}

export function markSplashDismissed() {
  splashDismissed = true;
  reportWhenUsable();
}
