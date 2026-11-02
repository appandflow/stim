export default {
  summary: 'stim share: a public, password-protected web link to a running app, watch only or with control',
  body: () => `SHARE: A PUBLIC WEB LINK TO A RUNNING APP

If Stim is not installed globally, replace stim with npx stim.

stim share gives someone outside your tailnet a link to watch the app running
on this workspace's Stim-owned simulator or emulator, or on the physical
device it leases, in any browser. With --control they can also tap, type and
press the hardware buttons. The link is public, so share it only when the user
asks for it.

  stim share ios                      # watch only, 60 minutes
  stim share android --control        # viewers can tap, type and press buttons
  stim share ios --expires 15         # minutes, 1 to 480; every share expires
  stim share android --device         # the leased physical phone
  stim share ios --slot tablet        # the device of another slot
  stim share list                     # live shares: target, control, viewers, expiry
  stim share stop                     # ends this workspace's shares now

It prints the URL and a generated password once. Neither is stored anywhere;
run stim share again for a new link. --json prints one payload with url,
password, expiresAt, control and the target.

WHAT IT NEEDS

- A running stim-server for this Stim home (Stim Desktop runs one, or
  stim-server service install). The share lives inside it: stim share refuses
  with STIM_SERVER_NOT_RUNNING without one, and a server restart ends every
  share.
- Tailscale running on this Mac, with Funnel allowed for this node by the
  tailnet policy. Stim never changes tailnet settings.
- One free Funnel port (443, 8443 or 10000, as the tailnet allows) that nothing
  in tailscale serve status uses.
- The device booted and owned by this workspace (or leased with --device).
  A physical iPhone is view only; --control with ios --device is refused.

SECURITY MODEL

- stim-server serves shares on its own listener, on a loopback port separate
  from its API. Only the share adds a Funnel route, and only to that listener:
  tailscale funnel --bg --yes --https=<port> http://127.0.0.1:<listener>. The
  route is removed when the last share ends. stim-server setup and service
  never enable Funnel.
- The listener serves three things for each share: the viewer page, the frame
  stream of the one shared device, and, with --control, input to that same
  device. Everything else, an unknown link included, is 404: no other device,
  log, file, command or stim-server method is reachable through it.
- The URL carries 256 random bits. The password is 16 random characters
  (about 79 bits), compared in constant time. Ten wrong passwords in ten
  minutes lock the share's login for the rest of that window, whatever the
  source address, so anyone with the link can lock it but not guess into it.
- A correct password sets an HttpOnly, Secure, SameSite=Strict cookie scoped
  to the share's path that ends with the share. The frame socket needs that
  cookie and a same-origin request. At most 5 viewers watch one share.
- Capture starts only when a signed-in viewer connects and stops about 10
  seconds after the last one leaves. A share never records: footage of share
  viewing is not written to disk.
- Control goes through the same control session and device lease stim-server
  uses for Desktop and the phone app: taps, text and the hardware buttons of
  the shared device only. A device an agent or another client drives answers
  busy instead of being taken over.
- A share ends at its expiry, on stim share stop, stim stop (without --slot),
  stim worktree remove, when its device stops or changes (stim stop --slot
  ends a share of that slot this way), and when stim-server stops. Ending
  closes its viewers' sockets. The last one removes the Funnel route first and
  only then closes the listener, so the route never points at a free port.
- The route is recorded under an ownership claim at
  $STIM_HOME/server/share-route. When stim-server crashed, the route stays
  public, pointing at a free loopback port, until the next stim-server start
  removes it, and only while the serve config still holds exactly that route;
  a route someone changed is left alone.
`,
};
