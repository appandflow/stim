export default {
  summary: 'stim web: an owned headless Chrome per workspace, its logs, launched, and teardown',
  body: () => `WEB: AN OWNED CHROME PER WORKSPACE

If Stim is not installed globally, replace stim with npx stim.

stim web opens this workspace's page in a Chrome that Stim owns, captures the
page's console, uncaught errors and failed requests in stim logs, and reports
whether the page loaded. It uses the installed Google Chrome (or Chromium)
with a profile Stim creates under STIM_HOME. Stim never installs a browser;
stim doctor reports a missing Chrome.

stim web never starts a web server, for any framework. It opens, reuses or
reloads the owned Chrome at the page URL. Every web project follows the same
two steps: start your dev server, then run stim web.

  stim web                 # headless, the default
  stim web --headed        # show the Chrome window
  stim web --json          # one payload on stdout; progress on stderr
  stim logs --errors       # page errors land here with platform "web"
  stim reload web          # Page.reload on the owned page
  stim stop                # closes Chrome with the rest; the profile stays

WHICH PAGE AND WHICH DEV SERVER

Expo web runs on the workspace's Metro. With web.url unset, an Expo app
opens http://localhost:<metroPort>/. Its dev server is stim start:

  npx expo install react-dom react-native-web @expo/metro-runtime   # once
  stim start
  stim web

Any other web server (Vite, Next, webpack) starts with its own command.
Reserve its port with stim ports get, start it with strict-port behavior, and
point web.url at it. {port:<label>} in web.url becomes that named port,
{port:metro} the Metro port:

  pnpm exec vite --port "$(stim ports get web)" --strictPort
  stim settings set web.url 'http://localhost:{port:web}/' --scope workspace
  stim web

When nothing serves the page, stim web still opens Chrome, reports launched
"unverified", and prints the remedy for this workspace: stim start for an
Expo web app, the stim ports get web recipe for any other server.

In a monorepo whose web app is its own package (apps/web beside apps/mobile),
stim ports, web, settings, logs, reload, stop and status run from the web
package resolve to the one Stim app registered in the same Git worktree; each
names the app on stderr, and status stars it. The port, the browser, web.url
and the logs all belong to that app's workspace, so every command can run from
the web package. Register the app first, from its directory. See stim guide
ports for the exact rule.

HTTPS dev servers with a self-signed certificate, such as Vite with
@vitejs/plugin-basic-ssl, fail with net::ERR_CERT_AUTHORITY_INVALID until
web.ignoreCertificateErrors is true, which accepts the certificate in the
owned profile only:
  stim settings set web.url 'https://localhost:{port:web}/' --scope workspace
  stim settings set web.ignoreCertificateErrors true --scope workspace
An https:// URL on a plain HTTP server fails with ERR_SSL_PROTOCOL_ERROR, and
an http:// URL on an HTTPS server with ERR_EMPTY_RESPONSE; the remedy line
prints the settings command that switches the scheme. web.viewport phone
gives the page a 390x844 touch screen at 3x instead of the 1280x800 desktop
window. See stim guide settings.

MONOREPO RECIPE: A VITE PACKAGE WITH A BASE PATH AND HTTPS

apps/web runs Vite through its dev script, serves the app under /apps/groups/,
and uses @vitejs/plugin-basic-ssl; apps/mobile is the Stim app. The flow is
the same as for any web project: start the dev server, then run stim web.

  cd apps/mobile && stim ports get web     # registers the app; no Metro
  cd ../web
  stim settings set web.url 'https://localhost:{port:web}/apps/groups/' --scope repo
  stim settings set web.ignoreCertificateErrors true --scope repo
  pnpm dev --port "$(stim ports get web)" --strictPort   # keep it running
  stim web
  stim logs --errors
  stim reload web
  stim stop               # closes Chrome; stim ports stop web stops Vite
  stim worktree remove    # in a linked worktree: Chrome, Vite and profile

The repo layer is shared by every worktree of the repository, so a new
worktree skips the two settings lines; the certificate and scheme remedies
print --scope workspace, which overrides it for one worktree only. Run ports
get from the app directory before any ports or web command in the web
package: a reservation made there first keeps the web package as its own
workspace until you release it and stop. Pass --port and --strictPort
through the dev script: Vite otherwise binds its config default and moves to
the next free port when that one is taken. Put the base path in web.url: a
path outside it can reach the dev server's proxy instead of the app. API
calls the dev server proxies to a backend that is not running fail as device
errors in stim logs --errors; the page still loads.

LAUNCHED

The web payload's launched keeps its native meaning, from evidence in the
owned page rather than a shared port:
  true           the page's document answered and its load event fired; on
                 Metro, the page also fetched a web bundle
  "bundling"     Metro was still building the web bundle when the check ended
  "unverified"   the document failed (for example ERR_CONNECTION_REFUSED:
                 the dev server is not running, or ERR_CERT_AUTHORITY_INVALID: a
                 self-signed certificate), loaded without a Metro bundle, or
                 did not finish: 20 seconds with no answer, 60 once a server
                 other than Metro answered. The remedy line names the fix
false is never produced. A page that loads and then throws is still launched
true; read stim logs --errors.

A second stim web with the same options reuses the running Chrome and
navigates it again. Changing --headed, web.viewport or the certificate
setting restarts it.

LOGS

Records go to web.ndjson in the workspace log directory, all with
platform "web":
  src client   console calls at their level (console.error is error) and
               uncaught errors and rejections, with stack frames
  src device   failed requests, which stim logs --errors includes: a failed
               page document is error whatever its
               status; another request's network failure or HTTP 5xx is
               error, a 4xx warn, a canceled request debug; browser messages such
               as CSP violations; the browser's own lifecycle
Expo also prints web console calls on Metro ("Web LOG"), so they can appear
twice: once from the page (client), once from Metro (metro, level info).
Each load of the page's top-level document is a page-load marker: stim web,
stim reload, and a reload or navigation the page makes itself. logs --errors
and the status error count report the page's records (platform web) from the
latest load only, the way Chrome DevTools clears its console when the page
navigates. A page load does not hide the native app's errors, and an ios or
android launch does not hide the page's.

AGENTS AND OTHER TOOLS ON THE SAME BROWSER

stim status --json shows environments[].web.cdpEndpoint, a reserved loopback
DevTools endpoint on 127.0.0.1. Point browser tools at it instead of letting
them start their own browser:
  Playwright MCP    --cdp-endpoint http://127.0.0.1:<port>
  agent-browser     --cdp <port>
The port reaches only the Stim profile: Chrome refuses remote debugging on
your default profile, and Stim never attaches to a browser it did not start.
The port is managed like metro: stim ports lists it as web-cdp (managed),
and ports get, stop and release refuse it.

OWNERSHIP AND CLEANUP

A browser supervisor process holds the DevTools session and an ownership
claim for its lifetime; Chrome is the claim's child. Stim signals the
supervisor or Chrome only after verifying the process identity it recorded.
  stim stop               closes Chrome and keeps the profile, so cookies and
                          storage survive the next stim web
  stim worktree remove    closes Chrome and deletes the profile
  stim gc --delete        does the same for a workspace whose path is gone,
                          and forgets ledger entries of deleted profiles
The profile is deleted only when the created-devices ledger lists it. After
Chrome is gone, Stim removes the SingletonLock files a killed Chrome leaves,
which would otherwise block the next launch. status reports
browser-unverified when an identity cannot be proven; follow stim guide
errors teardown.

LIMITS

Chrome and Chromium only. No Stim Desktop or phone viewer yet. The owned page
is one tab: a page the app opens in a new window is not captured.`,
};
