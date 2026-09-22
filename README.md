# Simple Share

Browser-to-browser file transfer with encrypted transport. File bytes and filenames travel only over the encrypted WebRTC data channel. Convex stores short-lived connection details and optional device-pairing metadata. STUN only; no TURN or file relay.

Live app: https://share.patrickshao.com · [MIT license](LICENSE) · [Security](SECURITY.md)

This repository starts from a reviewed source snapshot with no earlier development history.
See the [release security review](docs/security-review.md) and [contributing guide](CONTRIBUTING.md).

## Development

Requires Node.js 24+ and pnpm 10.28.2. Clone this repository and run the following from its root. Convex setup creates your own development deployment and `.env.local`; do not reuse the hosted app's backend. Keep `convex dev` running in one terminal and `pnpm dev` in another.

1. `pnpm install`
2. `pnpm exec convex dev`
3. `pnpm dev`
4. Open `http://localhost:3000` on the sending computer. The invite uses that computer's Wi-Fi address for the other device.

Set `NEXT_PUBLIC_CONVEX_URL` to your Convex deployment. Local Convex must use a LAN-reachable address for phone testing. Set `NEXT_PUBLIC_SIMPLE_SHARE_LAN_HOST` only if automatic adapter detection chooses the wrong address.

For an isolated frontend test instance: `SIMPLE_SHARE_DIST_DIR=.next-verify pnpm exec next dev --hostname 127.0.0.1 --port 3001`.

## Transfer

1. Choose up to 1,000 files / 20 GiB total and open a private room.
2. On the other device, scan the QR or open the invite to connect automatically, or enter the room code and choose **Join room**.
3. The sender automatically offers the selected files after device verification. Compare the safety codes, then accept on the receiver. File bytes are sent only after acceptance.
4. With folder receiving, files are saved automatically into a new numbered-file subfolder. Otherwise, save each received file or use **Save all as ZIP** for a single download. ZIP files keep the original file bytes and preserve duplicate filenames with numbered prefixes. The sender reports completion only after the receiver confirms all file sizes and the whole batch.
5. Choose **Send more** to send another collection over the same verified connection. Every collection still needs approval. The receiver can leave the completed screen open; **Receive from another device** ends that connection. Older tabs without repeat-transfer support show **Start another transfer** instead.

Rooms expire after 10 minutes and show a countdown. Cancel is available while preparing, waiting, connected or transferring. Stalls and disconnects fail with a retry path. Files that completed before a failure remain downloadable, including after starting another transfer or switching between Send and Receive. Save them before clearing received files or closing the tab. Interrupted files restart from the beginning on a new connection; this release does not resume across page reloads.

For selections over 256 MiB, browsers with folder access (typically desktop Chromium browsers on HTTPS) show **Choose save location**. Incoming chunks are written directly to disk, so an individual regular file can exceed 256 MiB, up to the 20 GiB selection limit. Existing files are preserved by using a new transfer subfolder; filenames receive sequence prefixes, and very long names may be shortened. Completed files remain on disk after a later failure. The app tries to remove an interrupted partial file; if browser shutdown or a disk error prevents cleanup, an empty/partial entry may remain.

Small selections, and browsers without folder access, show **Accept files**. Downloads from earlier collections stay available and count toward the same memory limit. Each file must be at most 256 MiB. A larger selection pauses before retained downloads would exceed 256 MiB: save the files, then choose **I’ve saved these — continue** to clear them and receive the next batch over the same connection. Progress covers the whole selection. Save/approval pauses time out after about 10 minutes. This mode cannot split one oversized file into independently usable downloads; receive that file in a supported desktop browser.

Both devices should refresh before using this transfer version. Older senders remain supported for small transfers; new senders require the updated receiver. No extra account, relay, or server file storage is introduced.

## Remember devices

Remembered pairing requires HTTPS or localhost and browser storage. Temporary room transfers still work on HTTP LAN origins. Use the same site address and browser each time: identities and pairings are scoped to that browser and origin.

1. Set a recognizable name under **Saved devices → This device**.
2. Establish a temporary connection and compare the safety codes.
3. The sender selects **Remember device**, compares the displayed code with the other screen, and selects **Codes match — remember**.
4. The receiver independently checks the codes and selects **Codes match — remember**.
5. For the next transfer, choose files and tap an available device beside the file selection (or select **Send** under Saved devices). An idle device with Simple Share open connects automatically. Its saved key is verified before the file offer; receiving file bytes still requires **Accept files**. Automatic connections do not interrupt an active transfer or a file selection already in progress.

Pairings last 30 days. **Forget** revokes both sides' future access, cancels pending rooms, and closes an active remembered connection when the clients receive the update. Offline revocation shows an error and preserves the local credential so you can retry. Clearing browser storage loses that browser's identity; the other device should forget it and pair again.

Each browser keeps a non-exportable ECDSA P-256 private key in IndexedDB and pins the other device's public key locally. Each new connection proves key possession using fresh challenges bound to that connection's WebRTC certificate fingerprints. The backend stores hashes of independent, random per-side pairing credentials, confirmation/expiry state, availability timestamps and pending room references. Device names and public keys are exchanged through the data channel and saved locally. No account or sign-in is required.

## Checks

- `pnpm test` — transfer protocol, failure recovery, cryptographic identity and handshake tests.
- `pnpm typecheck`
- `pnpm build`
- `SIMPLE_SHARE_TEST_CONVEX_URL=http://127.0.0.1:3210 node scripts/test-backend.mjs` — local backend lifecycle and access tests. Creates unique test records and cleans them up. Rejects non-local backend URLs.
- `SIMPLE_SHARE_TEST_CONVEX_URL=http://127.0.0.1:3210 node scripts/test-abuse-limits.mjs` — local-only creation-limit and rollback checks. Run after the lifecycle test; it consumes local limiter capacity temporarily and removes its test records.

Browser smoke testing uses separate origins (`localhost` and `127.0.0.1`) to represent independent browser identities. Test real phones on an HTTPS deployment before relying on a particular mobile browser's behavior.

## Deploy your own copy

1. Create your own Convex project and production deployment. Deploy the backend with `pnpm exec convex deploy` from that project.
2. Import your fork into Vercel as a Next.js project. The checked-in build command runs tests and uses Convex deploy to coordinate the backend deployment and Next.js build before Vercel publishes the frontend.
3. Create a production deploy key in your Convex dashboard. Add it to Vercel as **sensitive** `CONVEX_DEPLOY_KEY`, scoped to **Production** only. The build injects `NEXT_PUBLIC_CONVEX_URL` from that key. Never commit the key or prefix it with `NEXT_PUBLIC_`.
4. Push to your production branch (normally `main`). Verify both the Convex deployment and Vercel build succeeded before using the app.
5. Optionally attach your own domain in Vercel and add the DNS records Vercel supplies. Remembered devices are scoped to the origin, so changing domains requires pairing again.

Preview builds require a separate Convex preview deploy key scoped to Vercel's Preview environment. Without it previews fail closed. Never give untrusted pull-request code access to a production key. See [Convex's Vercel guide](https://docs.convex.dev/production/hosting/vercel).

Keep production and local environment files separate. Deploy backward-compatible backend changes because existing browser tabs may still run the previous frontend. Both devices should refresh after a protocol update.

See [SECURITY.md](SECURITY.md) for the shared creation limits, privacy boundaries, and private vulnerability reporting. For changes, run the checks above and explain the behavior and validation in your pull request. Real-device testing is especially useful for mobile browser behavior.

## Limits

- STUN only: some networks cannot establish a direct connection.
- One receiver per connection. No file relay, offline delivery or background push.
- Both apps must be open. Availability is approximate and fades after a minute without updates. Browser suspension or locking a phone can interrupt a transfer.
- Wake lock is requested while the room is active where the browser supports it. It cannot prevent manual device locking.

### Connection checks

After a failed connection, the troubleshooting panel checks WebRTC startup and gathers ICE candidates for up to eight seconds, with a manual retry. No diagnostic probe runs on the normal start screen. New users see a dismissible quick start instead. It distinguishes unavailable WebRTC, no candidates, local-only candidates, and public discovery responses. Discovery alone does **not** prove peer reachability, successful signaling, or a completed transfer. Connection failures/timeouts show recovery guidance with optional technical details. Public-only candidates trigger a local-route warning; this can indicate a browser privacy restriction but does not identify the exact setting. No files are sent, and the probe retains no SDP or IP addresses. It uses the transfer's existing STUN servers and closes its temporary peer on completion, timeout, retry, or unmount.

Brave privacy policies, VPNs, and Wi-Fi client isolation can prevent connections even on the same network. The page includes connection help and an alternate-browser suggestion. There is currently no TURN relay fallback.
