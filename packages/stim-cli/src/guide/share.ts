export default {
  summary: 'stim share: a public web link to a running app, password-protected by default, watch only or with control',
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
  stim share ios --password '<value>' # a password you choose, 8 to 128 characters
  stim share ios --no-password        # no login: the link alone opens it
  stim share list                     # live shares: target, control, viewers, expiry
  stim share stop                     # ends this workspace's shares now

It prints the URL and, by default, a generated password once. Neither is
stored anywhere; run stim share again for a new link. --json prints one
payload with url, auth (generated, set or none), expiresAt, control and the
target; password is in it only when it was generated. A password you set is
never printed back. A value passed on the command line can land in your shell
history and in ps output while stim share runs; prefer the generated one.

With --no-password, anyone with the link can watch, or control with
--control; stim share warns about it on stderr, and share list shows such a
share as "no password". The 256-bit link is then the only secret. Use it only
when the user asks for it.

WHAT IT NEEDS

- A stim-server for this Stim home. The share lives inside it, and a server
  restart ends every share. When none runs, stim share starts one in the
  background (stim-server --share: loopback only, no Desktop bootstrap) from
  the stim-server package of this exact stim version installed next to stim,
  else a stim-server on PATH that reports this version. It says so on stderr
  with the server's pid and log ($STIM_HOME/server/share-server.log). That
  server stops on its own when its last share ends (stim share stop, expiry,
  stim stop, worktree remove) or when no share starts within 2 minutes, and
  removes its Funnel route on the way out (it stays up, retrying, while that
  removal fails); stim share stop also stops it. When the Stim home does not
  answer at its startup it exits at once with the reason in its log. A
  server Stim Desktop, the LaunchAgent or you started is never stopped. When
  no matching stim-server is installed, or it does not start, stim share
  refuses with STIM_SERVER_NOT_RUNNING.
- One way to reach the share from the internet (share.exposure):
  - tailscale: Tailscale running on this Mac, with Funnel allowed for this
    node by the tailnet policy, and one free Funnel port (443, 8443 or 10000,
    as the tailnet allows) that nothing in tailscale serve status uses. Stim
    never changes tailnet settings.
  - proxy: your own reverse proxy and domain, see CUSTOM DOMAIN below.
  - auto, the default: tailscale when the tailscale command is installed and
    logged in, else proxy.
- The device booted and owned by this workspace (or leased with --device).
  A physical iPhone is view only; --control with ios --device is refused.
- Or a ready hosted session (ios|android --remote <machine>): this machine's
  stim-server relays frames and input through its existing device-host
  connection, one host stream for all viewers, none while nobody watches. The
  host needs no new approval. A session that is not ready refuses the share;
  the share ends when the session stops or is replaced, or the host stream or
  its connection fails; control the host refuses reaches the viewer as
  "Control is not available right now".

A LIVE SHARE KEEPS ITS WORKSPACE UP

A share that has not ended or expired keeps its workspace out of the idle
stage, the pressure ladder and the dormant stage, whether or not anyone
watches; with no stim-daemon, the dev server's supervisor keeps it up too.
The daemon never shuts its device down for a run waiting for a device slot;
that run keeps waiting and its progress line names the share. Automatic
maintenance and stim gc --delete keep the devices of its finished worktree.
Frames streamed to viewers are not activity, so the share alone holds it.
The stage line of stim status and the daemon's workspace_kept log name the
share. stim share stop or the share's expiry lets the idle stage proceed: a
workspace with no activity for idle.minutes goes idle on the next tick. When
stim-server cannot list its shares, the workspace stays up (guide lifecycle
budget).

CUSTOM DOMAIN (PROXY MODE)

Without Tailscale, for example on a cloud VM with Caddy, serve the share
listener through your own reverse proxy:

  stim settings set share.exposure proxy      # auto picks proxy only when tailscale is absent or logged out
  stim settings set share.publicUrl https://demo.example.com
  stim settings set share.port 7790           # the default; the proxy names this port

  demo.example.com {
    reverse_proxy 127.0.0.1:7790
  }

In proxy mode stim never runs tailscale serve or tailscale funnel (an auto
choice only reads tailscale status). The share listener binds 127.0.0.1 and
share.port only, so the proxy must run on the same machine; a port that is
taken refuses the share and names share.port. Links print under
share.publicUrl. Without it stim prints the loopback link and a warning, and
the link then only works on this machine.

The proxy must forward WebSocket upgrades (Caddy does; nginx needs the
Upgrade and Connection headers). It need not preserve the Host header or set
X-Forwarded-Host: the frame socket accepts exactly the Origin of
share.publicUrl and ignores Host and X-Forwarded-*. A path prefix in
share.publicUrl, such as https://example.com/stim, must be left on the path
when forwarding (Caddy handle /stim/*, never handle_path); the session cookie
and redirects are then scoped to the prefixed path. The proxy must end TLS:
the cookie is Secure. A setting changed while a share is live applies to the
next listener, after the last share ends. Only one stim-server can bind
share.port at a time.

SECURITY MODEL

- stim-server serves shares on its own listener, on a loopback port separate
  from its API. In tailscale mode only the share adds a Funnel route, and only
  to that listener: tailscale funnel --bg --yes --https=<port>
  http://127.0.0.1:<listener>. The route is removed when the last share ends.
  stim-server setup and service never enable Funnel. In proxy mode nothing is
  added to Tailscale, and the listener is reachable only by what runs on this
  machine, normally your reverse proxy.
- The listener serves three things for each share: the viewer page, the frame
  stream of the one shared device, and, with --control, input to that same
  device. Everything else, an unknown link included, is 404: no other device,
  log, file, command or stim-server method is reachable through it.
- The URL carries 256 random bits. The generated password is 16 random
  characters (about 79 bits); a password you set is 8 to 128 characters.
  Either is kept only as a SHA-256 digest and compared in constant time. Ten wrong passwords in ten
  minutes lock the share's login for the rest of that window, whatever the
  source address, so anyone with the link can lock it but not guess into it.
- A correct password sets an HttpOnly, Secure, SameSite=Strict cookie scoped
  to the share's path that ends with the share. The frame socket needs that
  cookie and a same-origin request. A share without a password needs no
  cookie: the link admits the page and the frame socket, which still needs a
  same-origin request. At most 5 viewers watch one share.
- Capture starts only when a signed-in viewer (any viewer with the link, for a
  share without a password) connects and stops about 10
  seconds after the last one leaves. A share never records: footage of share
  viewing is not written to disk.
- Control goes through the same control session and device lease stim-server
  uses for Desktop and the phone app: taps, text, rotation and the hardware buttons of
  the shared device only. A device an agent or another client drives answers
  busy instead of being taken over.
- A share ends at its expiry, on stim share stop, stim stop (without --slot),
  stim worktree remove, when its device stops or changes (stim stop --slot
  ends a share of that slot this way), when the device's frames fail, and when
  stim-server stops. Ending
  closes its viewers' sockets. The last one removes the Funnel route first and
  only then closes the listener, so the route never points at a free port.
- In tailscale mode the route is recorded under an ownership claim at
  $STIM_HOME/server/share-route. When stim-server crashed, the route stays
  public, pointing at a free loopback port, until the next stim-server start
  removes it, and only while the serve config still holds exactly that route;
  a route someone changed is left alone.
`,
};
