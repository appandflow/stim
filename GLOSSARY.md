# Stim

Stim gives each React Native or Expo workspace an isolated Metro port and an
owned simulator or emulator. Other machines on the tailnet can build for it or host
its devices.

## Remote machines

**Remote machine**:
Another machine on the tailnet, listed in this machine's `remote.machines`, that runs
Stim builds for it.
_Avoid_: worker (in user-facing text), build machine, remote builder, and remote
Mac except where only a Mac can build or host

**Build client**:
A machine that a remote machine has approved to build there; the remote machine lists
it among the machines that build here.
_Avoid_: paired machine, paired Mac

**Build request**:
A build client's ask for build access, held on the remote machine until a person
approves or denies it, or it lapses.
_Avoid_: pairing request, link request

**Approve**:
A person on the remote machine accepting a build request, with **Allow** in Stim
Desktop, `stim-server devices grant <id> --build`, or `stim-server setup`.
_Avoid_: pair, link

**Deny**:
A person on the remote machine refusing a pending build request.

**Revoke**:
A person on the remote machine removing access it had approved.

**Lapse**:
A pending build request expiring because nobody approved or denied it in time.
_Avoid_: revoke (for a request nobody answered)

**Stim build**:
The digest of the installed Stim packages; a build client and its remote machine
must run the same one.
_Avoid_: version (a checkout build and a release can share a version and differ)

**This Mac's build**:
The Stim build a build client runs, installed onto a remote machine as an npm
release or as the build client's packed packages.

## Phones

**Pair**:
Connecting a phone to a Mac's stim-server with a single-use QR code.
_Avoid_: pair for remote machines or hosted devices
