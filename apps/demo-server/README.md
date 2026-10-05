# Stim demo server

The machine App Review pairs the Stim iOS app with. It is a Cloudflare Worker that speaks the phone protocol of `stim-server` over `wss://` and serves fictional data: a Mac named `Demo Mac` with nine workspaces in two made-up repositories (`habitat-app`, `notes-app`), their simulators, emulators, logs, notifications and diffs. Device screens are renders of fictional apps (`frame-sources/`).

It is not published and is not part of Stim. `apps/mobile/mock-server` is the development counterpart; both use the payload helpers in `apps/mobile/mock-server/payloads.mjs`.

## How it works

- Every request with `Upgrade: websocket` goes to one Durable Object (`DemoServer`), so all phones share one machine. Other requests get `426`.
- Sockets use the WebSocket Hibernation API. The paired device is kept in the socket attachment; subscriptions run timers, so the object stays awake while a phone is subscribed and can hibernate when none is.
- The pairing token is the Worker secret `DEMO_TOKEN`. It never expires and can pair any number of phones. A paired phone gets a device token signed with `DEMO_TOKEN` (HMAC-SHA256), so it reconnects after restarts and deploys without storage. Changing `DEMO_TOKEN` unpairs every phone. Without `DEMO_TOKEN`, every pairing is refused.
- The pairing grants `read` and `control`. Control acknowledges every input; on the habitat-app and notes-app iOS simulators, each tap switches between two pre-rendered screens on every phone watching that device. Reload and stop answer after 0.8 seconds and change nothing.
- Fixtures and frames are bundled into the Worker as modules (`rules` in `wrangler.jsonc`), not served as static assets, so nothing is readable without pairing.

## Develop

```sh
pnpm install
pnpm --filter @stim-cli/core run build
cd apps/demo-server
echo 'DEMO_TOKEN=<any local value>' > .dev.vars
pnpm run dev                      # wrangler dev on http://127.0.0.1:8787, no Cloudflare account needed
pnpm test                         # protocol and sanitization tests
pnpm run test:live                # runs wrangler dev and drives it over a real WebSocket
pnpm run typecheck
```

To pair the phone app on a simulator with the local server, choose "Pair a machine", then "Enter the endpoint and token instead", and enter `ws://127.0.0.1:8787` and the token from `.dev.vars`. The app accepts plain `ws://` only for a loopback address; a deployed server is reached over `wss://`.

Render frames again with `frame-sources/render.sh [name...]` (macOS, Google Chrome). Every file under `fixtures/`, `frame-sources/` and `src/` must stay fictional: `test/sanitize.test.ts` rejects real user and host names, home paths other than `/Users/demo`, physical device UDIDs, email addresses, token values and links outside `github.com/example`.

## Deploy

`.github/workflows/demo-server-deploy.yml` deploys on every push to `main` that changes this package, and on manual dispatch. It runs in the `demo-server` GitHub environment and skips with a notice when the Cloudflare secrets are missing. A deploy restarts the Durable Object and disconnects every phone; the app reconnects by itself.

Secrets, on the repository or on the `demo-server` environment:

| Secret                  | Value                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | An API token with the "Edit Cloudflare Workers" template permissions for the account. |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID.                                                            |
| `DEMO_TOKEN`            | Optional. When set, each deploy uploads it as the Worker secret `DEMO_TOKEN`.         |

The account's `workers.dev` subdomain is `appandflow`, so the Worker `stim-demo` is at `https://stim-demo.appandflow.workers.dev` and phones pair with `wss://stim-demo.appandflow.workers.dev`. Until `DEMO_TOKEN` is set, the Worker refuses every pairing.

Set or rotate the review token from GitHub, then redeploy:

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='   # keep this value for the App Review notes
gh secret set DEMO_TOKEN --repo appandflow/stim             # paste it at the prompt
gh workflow run demo-server-deploy.yml --repo appandflow/stim
```

Without GitHub, set it once with `pnpm exec wrangler secret put DEMO_TOKEN` from this directory (after `wrangler login`), or in the Cloudflare dashboard under the Worker's Settings, Variables and Secrets. Then pair from a clean install of the app with the endpoint and the token, and put both in the App Review notes, never in this repository.

After the review, rotate `DEMO_TOKEN` or delete the Worker.

## Free plan

The Workers Free plan allows only SQLite-backed Durable Objects (the `new_sqlite_classes` migration), 100,000 Durable Object requests a day and 13,000 GB-s of duration a day; incoming WebSocket messages count 20 to 1 as requests, and outgoing messages are free ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)). One object at 128 MB awake for a whole day uses about 10,800 GB-s, so a phone connected around the clock still fits. A deploy disconnects every socket ([WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).
