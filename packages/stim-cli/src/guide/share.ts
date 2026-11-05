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
  stim share ios --slug pokedex       # link /s/pokedex/ instead of a random token
  stim share android --control --view-password   # a second, watch-only password, generated
  stim share android --control --view-password '<value>'   # or one you choose
  stim share list                     # shares: target, control, state, viewers, expiry
  stim share stop                     # ends this workspace's shares now
  stim share ios --reuse              # starts the stopped share again: same link, password and expiry
  stim share stop --forget            # stop, and delete the saved links

It prints the URL and, by default, a generated password. stim saves both for
--reuse (see SHARE AGAIN AFTER A STOP), so a lost generated password is printed
again by --reuse. --json prints one
payload with url, auth (generated, set or none), expiresAt, control and the
target; password is in it only when it was generated. A password you set is
never printed back. A value passed on the command line can land in your shell
history and in ps output while stim share runs; prefer the generated one.

--view-password is for --control shares: --password (or the generated one) stays
the control password and --view-password adds a password that only watches. A
value is 8 to 128 characters; without one a password is generated. It refuses
with STIM_BAD_ARG without --control, with --no-password, and when it equals
--password. Put it last, or write --view-password=<value>, so a following word
is not read as its value. The output then lists both passwords, and --json adds
viewAuth (generated, set or null) and viewPassword, present only when it was
generated.

SHARE AGAIN AFTER A STOP

stim share stop and stim stop end a share and its link stops working; a
stim-server restart ends it only until the server starts again (see below). A share started by stim share ios|android or by Stim Desktop is saved: stim-server writes the link's 256-bit URL token and its
passwords, in clear, in share-links.json in the workspace's directory under
$STIM_HOME/workspaces (mode 0600; written when a share starts, whichever client started it; deleted with the
workspace, by stim share stop --forget, and when stim share, starting, reusing or
stopping in the workspace, finds it expired). stim share ios|android --reuse starts that
target's saved link again (a share started with --slug is saved and started again
by its slug, with its password; --device and --slot pick the target) until it
expires: the same URL token, passwords and setup, the same expiry. The control,
view-only and password setup comes from the saved share, so --reuse with
--control, --password, --no-password or --view-password fails with
STIM_BAD_ARG. --expires <minutes> replaces the expiry with that many minutes
from now (1 to 480, so it can extend or shorten) and the saved expiry follows;
an expired link is never extended. Nothing saved (no share started for that
target, expired, forgotten) fails with STIM_SHARE_NOTHING_TO_REUSE and starts
nothing: it never falls back to a new share. A link that is live or waiting now
is refused with STIM_SHARE_REFUSED ("That link is live now"). --json adds
reused: true and, for generated passwords, password and viewPassword; a
password you set is never printed back. The address in the link is the one the
listener has now; stim says so when it differs from the saved one.

stim share stop keeps the saved links and lists them (platform, slot, expiry;
reusable in --json, never a secret): stop is a pause, not a revocation, until
the expiry. stim share stop --forget also deletes them, with or without a
running stim-server. Each saved link records whether its share should be
running (live) or was stopped on purpose (stopped); stim share, stim stop and
share.stop (also Stim Desktop's Stop) change it, so a stim-server restart or
crash leaves it live. When a full stim-server starts (not the --share one) it
starts every live, unexpired
saved share again by itself, with the same link, passwords and expiry; one whose
device is not there yet waits for it. A share started from Stim Desktop is
saved the same way, so it comes back too and --reuse finds it. Tell the
user that the saved file holds the token and passwords; when they want a link
revoked for good, run stim share stop --forget.

A SHARE WAITS FOR ITS DEVICE

A share follows the workspace's device in its slot, so running stim ios or
stim android again, or rebuilding, does not end it. When the device goes away
on its own (the frame stream fails, as it does when an app install closes a
hosted session's capture; the simulator or emulator shuts down or is replaced;
the hosted session stops or is replaced) the share waits: viewers stay
connected and signed in, see the dimmed last frame and "Waiting for the
device...", and the link, passwords, sessions and expiry stay. Control is
released. When the slot's device is back (booted, running, or a ready hosted
session) the share resumes on the same page with no reload and no new
password; control starts again for the viewers that can control. If the slot now runs another
simulator or emulator, the share resumes on that one. After a failed stream it
retries every few seconds, up to 30 seconds apart. share list shows
"waiting for the device" and --json rows have state (live or waiting). A
waiting share still expires at its expiry, still keeps its workspace up and its
stim-server running.

A viewer whose connection drops (a stim-server restart or update, a network change, a phone that slept) keeps the
dimmed last frame, shows "Reconnecting..." and rejoins on its own, with no reload: it retries after 1 second,
doubling up to 15 seconds, and at once when the browser is back online or the page becomes visible. When the server
no longer knows its sign-in (after a restart) it shows the login page of the same link; when the link is not found
(a stopped share) it keeps trying every 30 seconds for 10 minutes, so a share that comes back with the same link is
joined again. When stim-server itself stops, viewers get a plain close, not "ended", and reconnect the same way.
"This share has ended." from a stop or expiry is final.

Only an explicit stop ends a share early: stim share stop, stim stop (the
workspace, or one slot with --slot), stim worktree remove, Stop in Stim
Desktop, or stim-server stopping. Tell the user a share survives a rebuild;
never run stim share stop to "restart" one.

TAB TITLES

The viewer tab is titled "<app name> \u00b7 <device model> \u00b7 Stim" (a simulator app's display name from its
Info.plist, else "Live iOS app"; the model from the simulator name without the Stim label and runtime version), the
login page "<app name> \u00b7 Stim", and an ended or unknown link "Share ended \u00b7 Stim". They never carry the
project, workspace or branch name, and the viewer tab follows the app when it changes.

VIEWERS SEE EACH OTHER

Every viewer has a name (asked on first load, optional; empty means Guest 1, Guest 2 and so on)
and a color. The names Host, Agent (also "Agent \u00b7 <command>") and Guest N
are the server's own, so a viewer that picks one of them is shown as its Guest
N. Viewers of one share see each other's touches live, with the name, and never
those of another share's viewers, even of the same device; every share also
sees the agent's actions (from stim agent-device, or from agent-device run directly on an owned simulator or
emulator) and the host's touches, shown as Host, when the device is controlled from Stim Desktop or the phone. The names live in stim-server's
memory for the share and are never logged or written to disk. Clicking the row of colored initials in
the top bar opens a People list: each person with a role (controlling, can control or view only), the
host and the agent when they are on the device, and a Change name action on the viewer's own row. Presence shows where people tap, a PIN pad
included; the screen is already shared, so it adds little, but say so when you
share a device that shows secrets. One viewer at a time holds the touch
pointer, from finger down to finger up or ten seconds without input: another
viewer's touch meanwhile is dropped and that viewer sees who is using the
screen. A view-only viewer sees the same and sends nothing. Hosted sessions
(--remote) work the same: viewers, touches and the pointer grab live in this
machine's stim-server, and the agent's actions on the hosted device come from
the host Mac (a host on an older Stim shows none; stim agent-device still shows
the agent's command).

A READABLE LINK (--slug)

--slug <name> makes the link <public url>/s/<name>/ instead of a random
256-bit token, for a demo link someone can type or read aloud. A slug is 3 to
32 lowercase letters, digits and hyphens, starting and ending with a letter or
digit; assets is reserved. Anyone can guess a slug, so the password is the
share's only secret: --slug refuses with STIM_BAD_ARG with --no-password, and
anyone who knows the link reaches the login page and can spend the share's
wrong-password budget (10 wrong passwords in 10 minutes lock new logins for
that share; signed-in viewers stay). Keep the generated password, or set a
long one. A slug a live share uses is refused with STIM_SHARE_REFUSED, naming
that share; stim share stop in its workspace, or its expiry, frees it. Nothing
reserves a slug after its share ends. share list and --json show slug. A
stim-server older than this stim refuses --slug; update it.

With --no-password, anyone with the link can watch, or control with
--control; stim share warns about it on stderr, and share list shows such a
share as "no password". The 256-bit link is then the only secret. Use it only
when the user asks for it.

WHAT IT NEEDS

- macOS or Linux. stim talks to the stim-server through its local socket,
  which Windows does not have, so on Windows every stim share action refuses
  at once with STIM_SHARE_REFUSED and starts no server. Run stim share on the
  macOS or Linux host that runs the device.
- A stim-server for this Stim home. The share lives inside it, and a server
  restart ends every share until the next one starts and restores the saved ones. When none runs, stim share starts one in the
  background (stim-server --share: loopback only, no Desktop bootstrap) from
  the stim-server package of this exact stim version installed next to stim,
  else a stim-server on PATH that reports this version. It says so on stderr
  with the server's pid and log ($STIM_HOME/server/share-server.log). That
  server stops on its own when its last share ends (stim share stop, expiry,
  stim stop, worktree remove) or when no share starts within 2 minutes, and
  removes its Funnel route on the way out (it stays up, retrying, while that
  removal fails); stim share stop also stops it, unless a share start is still
  in flight (another workspace's may wait for its devices), which it leaves
  running and says so. When the Stim home does not
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
  connection, one host stream for the H.264 viewers and one for the JPEG
  viewers, none while nobody watches. The
  host needs no new approval. A session that is not ready refuses the share;
  once started, a session that stops, is replaced or loses its capture makes
  the share wait and resume (A SHARE WAITS FOR ITS DEVICE); control the host
  refuses reaches the viewer as "Control is not available right now".

A LIVE OR WAITING SHARE KEEPS ITS WORKSPACE UP

A share that has not ended or expired, waiting ones included, keeps its workspace out of the idle
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

A share start, and the restart of a saved share with stim-server, holds the
workspace's native-run claim (native-run.lock) while it reads the device and
registers the share, so an automatic shutdown or device deletion runs before or after it,
never in between. It waits up to 30 seconds for a stim ios, android or stop run
or an automatic shutdown that holds the claim, then fails with
STIM_SHARE_REFUSED naming the claim; run stim share again once that run ends. A
restart retries on its own for as long as its saved entry is live. stim stop and
stim ios wait for a start to finish, including opening the share's route.

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
next listener, after the last share ends; with the background service and
share.publicUrl set it applies when the next share starts or the service
restarts. Only one stim-server can bind share.port at a time.

Links that ended or never existed: when stim-server runs as the background
service (stim-server service install) and share.publicUrl is set in proxy mode,
the listener binds share.port when the service starts and stays bound with no
share live. It answers every request that is not a live share's, any path and
method, with a "This share has ended or the link is wrong" page in the viewer's
design and status 404, the same for a link that ended and one that never
existed (nothing about an ended share is kept). The page holds no share data
and lists no shares; it sends Cache-Control: no-store and a strict CSP. The
listener binds 127.0.0.1 only, adds no Tailscale route and no
server/share-route claim, and closes when the service stops. The on-demand
stim-server --share still exits after its last share, and tailscale exposure
keeps no listener. A taken port is logged once; the next stim share refuses and
names share.port.

When stim-server is not running at all, the proxy needs its own page. The
@stim-cli/server package ships dist/share-viewer/not-running.html (the same
design, stylesheet inlined, no script). Copy it next to the proxy config, for
example:

  cd "$(mktemp -d)" && npm pack @stim-cli/server
  tar -xzf stim-cli-server-*.tgz package/dist/share-viewer/not-running.html
  sudo install -D -m 644 package/dist/share-viewer/not-running.html /var/www/stim-share/not-running.html

and answer 503 (temporary: the same link works once Stim runs) for the proxy's
own 502, 503 and 504, never for the listener's 404, which passes through.
Caddy:

  demo.example.com {
    reverse_proxy 127.0.0.1:7790
    handle_errors {
      @down expression {http.error.status_code} in [502, 503, 504]
      handle @down {
        rewrite * /not-running.html
        file_server {
          root /var/www/stim-share
          status 503
        }
      }
    }
  }

nginx (proxy_intercept_errors replaces only the codes named in error_page;
$connection_upgrade comes from the usual map block):

  location / {
    proxy_pass http://127.0.0.1:7790;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_intercept_errors on;
    error_page 502 503 504 =503 /not-running.html;
  }
  location = /not-running.html {
    internal;
    root /var/www/stim-share;
  }

STATS PANEL
Add ?stats to a viewer link to show a panel over the page with the video's round
trip, frames per second, bitrate, delay (p50 and p95) and keyframe requests. The
page measures them over its share socket; the round trip and delay need the
page to ping the server every 2 s, which it does only while the panel is open.

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
- A share can have a view password next to its control password. Login
  compares what was typed with both digests, always both, in constant time,
  and the matching password sets the session's access: control or view. Wrong
  passwords of either kind count against the one window. The server drops
  every input from a view session whatever the page sends; the page then shows
  "View only" and no device controls. A view session can raise itself to
  control from the bar by entering the control password (same login, same
  cookie); a session is never lowered. The access level is held in the server's
  memory, never in the cookie. A share keeps 32 sessions. A new login drops
  the oldest session of its own access first; a view login never drops a
  control session and is refused when only control sessions are left, and a
  share admits 30 new view sessions in ten minutes.
- A correct password sets an HttpOnly, Secure, SameSite=Strict cookie scoped
  to the share's path that ends with the share. The frame socket needs that
  cookie and a same-origin request. A share without a password needs no
  cookie: the link admits the page and the frame socket, which still needs a
  same-origin request. At most 5 viewers watch one share.
- A browser that decodes H.264 with WebCodecs (Chrome, Edge, Safari 16.4+ on
  macOS and iOS, desktop Firefox 130+) gets video at up to 60 fps, 1280 px on
  the long edge, 3 to 8 Mbit/s (4.5 at most for hosted video); others, and
  a browser whose decoder fails, get JPEG at 10 fps. A viewer that falls behind
  skips to the next keyframe, and a joining viewer gets a keyframe at once.
  #jpeg on the link forces JPEG.
  Measured on a local iOS simulator share of an animation in Chrome through
  Funnel: H.264 54 fps at 4.8 Mbit/s, 7 ms median capture to screen; JPEG
  9 fps at 4.0 Mbit/s.
- Capture starts only when a signed-in viewer (any viewer with the link, for a
  share without a password) connects and stops about 10
  seconds after the last one leaves. A share never records: footage of share
  viewing is not written to disk.
- Control goes through stim-server's control hub and device lease, which Desktop
  and the phone app use too. A viewer that can control starts the share's
  session, and so takes the device lease, when it connects, and the session ends
  after 5 minutes without input or when the last viewer leaves. It carries taps, two-finger gestures, text, the arrow keys, Escape and keyboard shortcuts, rotation and the
  hardware buttons of the shared device, plus the device clipboard on an iOS simulator, an Android emulator or an
  Android phone only. Viewers, Stim Desktop, the phone app and agents control
  the device at the same time; none of them refuses or takes over the others' control. The device has
  one touch pointer: whoever puts a finger down holds it until they lift it,
  and a touch from anyone else meanwhile is dropped with "Name is using the
  screen".
- Clipboard, with --control on an iOS simulator, Android emulator or Android phone: Command-V or Control-V while
  the screen has focus pastes the browser's clipboard text (up to 8 KiB) into the device's focused field; an iOS simulator types printable ASCII, line breaks and tabs, and pastes other text with Command-V, which lands without a prompt in an app Stim installed on an owned simulator (Stim allows its paste permission) and where iOS can ask first in any other app. The
  top bar's options menu has a Sync clipboard switch, on by default for control viewers and remembered in the
  browser: while the page is focused and visible it polls the device clipboard every two seconds (slower after
  failures) and writes new text to the browser clipboard, with a Copy from device chip when the browser refuses
  the write, and where the browser allows reading its clipboard (Chromium, after one permission prompt) it sends
  the browser's new text to the device when the page regains focus. The menu's Copy from device button copies
  once. On a touch-first browser (a phone or tablet) there is no automatic sync, because a browser lets a page read
  or write the clipboard only inside a tap: the switch is replaced by a Paste to device button, which reads the browser
  clipboard inside the tap (iOS Safari shows its own Paste button to confirm, Android Chrome asks for clipboard
  permission once) and sends it as the same paste Command-V sends, with a short note when the read is denied or empty,
  and Copy from device fetches the device text and writes it with a ClipboardItem that holds a promise, which keeps the
  tap's permission to write; when the browser still refuses, the text shows in a field to select. Command-V still works
  on a tablet with a keyboard. Sending the browser's new text to the device is an input: it starts the control session like a paste, and on an
  Android phone takes its lease. The polling never starts the control session and never keeps it alive: it reads only while a session runs
  (from the moment a viewer that can control connects) and does not count as input for the 5 minute idle end. Text a control
  viewer sends reaches the device clipboard and then every other control viewer's browser with sync on. A share without --control, a web page and a macOS app never read or set the device clipboard, and the text is never
  logged. The stim-server protocol methods are input.clipboard.set and input.clipboard.get, behind the hello
  feature device-clipboard.
- Two-finger gestures on an iOS simulator, Android emulator or Android phone: two real
  fingers on a phone or tablet, Option-drag with a mouse for a pinch (the second finger mirrors
  the first through the screen center) and Shift-Option-drag to move both fingers together. A
  circle marks each finger while Option is held.
- A share ends at its expiry, on stim share stop, stim stop (the workspace, or
  one slot with --slot), stim worktree remove, Stop in Stim Desktop, and when
  stim-server stops. A device that goes away only makes it wait. Ending
  closes its viewers' sockets. The last one removes the Funnel route first and
  only then closes the listener, so the route never points at a free port (the
  listener the background service keeps in proxy mode stays bound until the
  service stops).
- In tailscale mode the route is recorded under an ownership claim at
  $STIM_HOME/server/share-route. When stim-server crashed, the route stays
  public, pointing at a free loopback port, until the next stim-server start
  removes it, and only while the serve config still holds exactly that route;
  a route someone changed is left alone.
`,
};
