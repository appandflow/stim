if (__DEV__) console.info('[stim:readiness] pending');

let macsLoaded = false;
let splashHidden = false;
let reported = false;

function reportWhenUsable() {
  if (reported || !macsLoaded || !splashHidden) return;
  reported = true;
  if (__DEV__) console.info('[stim:readiness] ready');
}

export function markMacsLoaded() {
  macsLoaded = true;
  reportWhenUsable();
}

export function markSplashHidden() {
  splashHidden = true;
  reportWhenUsable();
}
