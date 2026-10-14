# Stim demo server

The machine App Review pairs the Stim iOS app with. It is a Cloudflare Worker that speaks protocol 2 of `stim-server` over `wss://` and serves fictional data: a Mac named `Demo Mac` with nine workspaces in two made-up repositories (`habitat-app`, `notes-app`), their simulators, emulators, logs, notifications and diffs. Device screens are renders of fictional apps (`frame-sources/`).

It is not published and is not part of Stim. `apps/mobile/mock-server` is the development counterpart; both use the payload helpers in `apps/mobile/mock-server/payloads.mjs` and add each environment's `stage`, `appPresence` and `gitChip` with core's `withDerivedFacts`.

## How it works

- Every request with `Upgrade: websocket` goes to one Durable Object (`DemoServer`), so all phones share one machine, and so does `GET /pairing`. Other requests get `426`.
- Every connection runs the protocol 2 Noise handshake of `docs/specs/2026-10-13-pluggable-transports-design.md` ("Authentication") through core's `acceptNoise`: `XXpsk2` when a phone presents the pairing token, `XX` when a paired phone returns. A protocol 1 `hello` gets the cleartext `protocol-unsupported` reply and a 4400 close.
- The pairing token is the Worker secret `DEMO_TOKEN`, 43 base64url characters of 32 random bytes. Unlike a stim-server pairing token, it is never spent, never expires and pairs any number of phones. Without a valid `DEMO_TOKEN`, every phone is refused.
- The object's SQLite storage keeps the server's X25519 key, created on first start, and one record per paired phone, keyed by the phone's static key. Both survive restarts and deploys, so a paired phone comes back with `XX`. A record names the `DEMO_TOKEN` it paired with (its `lookup`), so changing `DEMO_TOKEN` unpairs every phone. Records are never pruned, so rotating back to an old token revives the records that paired with it.
- workerd's `node:crypto` (the Worker runs with `nodejs_compat`) provides ChaCha20-Poly1305, SHA-256 and HMAC, but its `diffieHellman` fails for every imported X25519 public key, so X25519 comes from `@noble/curves`. `test/vectors.ts` runs core's shared Noise and framing vectors through that combination, in Node and in workerd.
- Sockets use the WebSocket Hibernation API. Subscriptions run timers, so the object stays awake while a phone is subscribed and can hibernate when none is. A session's cipher states live in memory, so after hibernation the object closes a paired socket with 1012 on its next message, and the app reconnects by itself.
- The pairing grants `read` and `control`. Control acknowledges every input; on the habitat-app and notes-app iOS simulators, each tap switches between two pre-rendered screens on every phone watching that device. Reload and stop answer after 0.8 seconds and change nothing.
- Limits: the Worker answers `403` to an upgrade that carries `Sec-Fetch-Site` or an `Origin` other than its own host (the phone app sends none or one derived from its `wss://` address), and the object answers `503` while 32 sockets are open. A socket that sends nothing within 10 seconds of opening, does not finish the handshake within 10 seconds of its first message, or sends no `hello` within 10 seconds of the handshake is closed; `hello` must come before any other request. One connection holds at most 16 `frames.subscribe`, 8 `logs.subscribe`, 8 `workspace.subscribe`, 2 `status.subscribe`, 2 `workspaces.subscribe` and 2 `machine.subscribe` subscriptions; a further one gets `limit-exceeded`. Per-IP rate limiting is a Cloudflare rule on the zone, not part of this package.
- Fixtures and frames are bundled into the Worker as modules (`rules` in `wrangler.jsonc`), not served as static assets, so nothing is readable without pairing.
- Each log fixture names its workspace. Queries and subscriptions serve only that workspace's records; keep its error records consistent with `logs.errorsSinceMarker` in the status fixture.

## Develop

```sh
pnpm install
pnpm --filter @stim-cli/core run build
cd apps/demo-server
echo "DEMO_TOKEN=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" > .dev.vars
pnpm run dev                      # wrangler dev on http://127.0.0.1:8787, no Cloudflare account needed
pnpm test                         # protocol and sanitization tests
pnpm run test:live                # runs wrangler dev, pairs with core's initiateNoise, and runs the vectors in workerd
pnpm run typecheck
```

To pair the phone app on a simulator with the local server, choose "Pair a machine", then "Enter the endpoint and token instead", and enter `ws://127.0.0.1:8787` and the token from `.dev.vars`. The app accepts plain `ws://` only for a private address; a deployed server is reached over `wss://`.

Render frames again with `frame-sources/render.sh [name...]` (macOS, Google Chrome). Every file under `fixtures/`, `frame-sources/` and `src/` must stay fictional: `test/sanitize.test.ts` rejects real user and host names, home paths other than `/Users/demo`, physical device UDIDs, email addresses, token values and links outside `github.com/example`.

## Deploy

The demo server deploys with the phone app, because it exists only for App Review and must match the build under review. `.github/workflows/mobile-release.yml` calls `.github/workflows/demo-server-deploy.yml` first, on a `mobile-v*` tag and in modes `auto`, `update` and `build`, and builds or publishes only after the deploy and its smoke test pass. Modes `rollback` and `republish` do not deploy. A merge to `main` does not deploy. Run `demo-server-deploy.yml` by hand to redeploy without a release, such as after rotating `DEMO_TOKEN`.

The deploy runs in the `demo-server` GitHub environment and refuses a commit that is not on `main`. Without `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` it skips with a notice and the release goes on. A deploy restarts the Durable Object and disconnects every phone; the app reconnects by itself.

The environment's deployment rule is a GitHub repository setting that code cannot change. In Settings, Environments, `demo-server`, Deployment branches and tags, choose "Selected branches and tags" and allow the branch `main` (manual runs and dispatched releases) and the tag pattern `mobile-v*` (tag releases). A ref the rule does not allow cannot deploy.

After `wrangler deploy`, `scripts/smoke.mjs` checks the deployed Worker at `https://stim-demo.appandflow.workers.dev`: it retries `GET /pairing` for about 30 seconds until a protocol 2 pairing code answers, runs a protocol 2 first contact with core's `initiateNoise` and `DEMO_TOKEN`, checks that the server key matches the pairing code's fingerprint, sends `hello` and waits for a status event. A failed check fails the job and names it. A refused first contact usually means `DEMO_TOKEN` is not 43 base64url characters. The smoke test derives its client key from `DEMO_TOKEN`, so every deploy pairs the same device record, named `Deploy smoke test`, again instead of adding one; anyone with the token can pair a phone anyway. It prints neither the token nor any key. Without `DEMO_TOKEN` it skips with a notice. Only CI runs it against the deployed Worker; `pnpm run test:live` runs it against `wrangler dev`.

Secrets, on the repository or on the `demo-server` environment:

| Secret                  | Value                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | An API token with the "Edit Cloudflare Workers" template permissions for the account.                          |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID.                                                                                     |
| `DEMO_TOKEN`            | Optional. When set, each deploy uploads it as the Worker secret `DEMO_TOKEN` and the smoke test pairs with it. |

The account's `workers.dev` subdomain is `appandflow`, so the Worker `stim-demo` is at `https://stim-demo.appandflow.workers.dev` and phones pair with `wss://stim-demo.appandflow.workers.dev`. Until `DEMO_TOKEN` is set, the Worker refuses every pairing.

Set or rotate the review token from GitHub, then redeploy:

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='   # keep this value for the App Review notes
gh secret set DEMO_TOKEN --repo appandflow/stim             # paste it at the prompt
gh workflow run demo-server-deploy.yml --repo appandflow/stim
```

Without GitHub, set it once with `pnpm exec wrangler secret put DEMO_TOKEN` from this directory (after `wrangler login`), or in the Cloudflare dashboard under the Worker's Settings, Variables and Secrets. Then pair from a clean install of the app with the endpoint and the token, and put both in the App Review notes, never in this repository.

`https://stim-demo.appandflow.workers.dev/pairing` returns the v2 pairing code without its token, `{ "v": 2, "name", "endpoint", "fingerprint" }`. Add `"pairingToken"` to make the code a QR code scans; the fingerprint pins the server key the first handshake must prove.

After the review, rotate `DEMO_TOKEN` or delete the Worker.

## Free plan

The Workers Free plan allows only SQLite-backed Durable Objects (the `new_sqlite_classes` migration), 100,000 Durable Object requests a day and 13,000 GB-s of duration a day; incoming WebSocket messages count 20 to 1 as requests, and outgoing messages are free ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)). One object at 128 MB awake for a whole day uses about 10,800 GB-s, so a phone connected around the clock still fits. A deploy disconnects every socket ([WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).
