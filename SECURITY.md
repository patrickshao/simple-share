# Security

## Reporting a vulnerability

Use GitHub's **Security → Report a vulnerability** for this repository:
https://github.com/patrickshao/simple-share/security/advisories/new

If private reporting is unavailable, open an issue asking the maintainer to
enable it, without including exploit details, credentials, or private data.
Please do not test abuse limits against the shared hosted service. Use your own
local deployment and include reproduction steps and the affected commit.
This is a personal project; there is no guaranteed response time. Fixes target
the latest `main` revision.

## Trust and privacy

File bytes and filenames are sent through the WebRTC data channel, not stored
in Convex. Convex receives SDP/ICE connection metadata, which can include IP
addresses, and short-lived room credentials. STUN providers see network
addresses. Direct peers can learn each other's IP addresses. This is not an
anonymity tool.

Compare safety codes through a trusted channel for an initial connection.
Remembered devices pin public keys and prove possession on future connections.
Encryption still depends on trusting the delivered JavaScript, hosting provider,
browser, and endpoint devices. HTTP LAN development does not authenticate the
delivered application; use HTTPS for sensitive transfers. This project has not
had an independent security audit.

Receiving requires explicit approval. Received downloads are untrusted files;
the app does not scan their contents. Browser storage holds pairing credentials
and a non-exportable signing key. Non-exportability does not protect against
malicious code running in that same origin.

## Hosted-service abuse limits

Global token buckets limit successful room creation to a burst of 60, refilling
at 60/minute, plus a 2000-token bucket refilling at 2000/day. Pair creation uses
a burst of 20, refilling at 20/minute, plus 200 tokens refilling at 200/day.
These are shared across all clients and cannot be bypassed by choosing new IDs.
They are not exact calendar-day quotas. Exhaustion can temporarily deny service
to legitimate users. Rejected requests and reads still consume backend resources;
these limits are not comprehensive DDoS protection or a spending cap.

Operators should monitor Convex usage and set provider budget alerts/limits as
appropriate. Limits are defined in `convex/limits.ts`. Do not put production
deploy keys in preview builds or workflows that execute untrusted pull requests.

## Release review and remaining boundaries

The source review and reproducible checks for the initial public release are
recorded in [docs/security-review.md](docs/security-review.md). This is a
maintainer-assisted review, not an independent audit or a guarantee of security.

Room codes are short-lived bearer invitations with 40 bits of randomness. Anyone
who obtains one can view its connection metadata and race to join a temporary
room. Share codes privately and compare the safety code before accepting files.
The backend's global creation quotas do not limit room-code read attempts.
Remembered-device rooms additionally require a 256-bit pairing credential and
pinned-key verification. New links use a URL fragment to keep room codes out of
HTTP requests; legacy query links still reach hosting logs on their first request.

Security headers deny framing and referrers and disable object embedding. The
CSP is deliberately limited to those controls; it does not provide a strict
script-src policy. Received files are offered as generic downloads, never inline
previews. Their contents remain untrusted after download.
