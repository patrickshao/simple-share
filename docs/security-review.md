# Initial public release security review

Review date: 2026-09-22. Scope: the complete tracked application source,
configuration, lockfile, tests, and publication snapshot. Conducted by the
maintainer with an AI coding assistant; not an independent penetration test.

## Threat model

Untrusted peers may send arbitrary control frames, filenames, sizes, ICE/SDP,
and device proofs. Anonymous clients can call the public Convex functions.
A repository contributor must not receive production credentials through CI.
The browser, delivered JavaScript, hosting infrastructure, and endpoint operating
systems remain trusted. Compromised endpoints and downloaded malware are outside
the protection offered by transport encryption.

## Findings resolved before publication

| Finding | Resolution | Verification |
| --- | --- | --- |
| Peer-controlled MIME types on application-origin blob URLs could permit active documents to render if opened | Always expose received blobs as `application/octet-stream`; preserve bytes and download filenames | Regression test and real-browser HTML transfer |
| Outer asynchronous message queue could retain unbounded frames during device verification | Validate frame sizes and cap queued messages/bytes before asynchronous dispatch; fail closed on excess | Flood, oversized-frame, and ordered-dispatch tests |
| Additional peer-created data channels could replace the active transfer session | Accept only the first `simple-share` channel; close extras and unexpected labels | Real-browser extra-channel rejection followed by a successful repeat transfer |
| Query-string invitations disclose room codes to HTTP access logs | Generate fragment links and remove imported invite parameters from browser history; keep legacy query support | Browser fragment invitation and URL cleanup |
| Missing clickjacking and referrer defenses | Deny framing, disable referrers/object embedding/base URLs, add nosniff and camera/microphone/geolocation restrictions | Production HTTP header checks |
| Build machine LAN address automatically embedded in production JavaScript | Auto-detect LAN addresses only in development | Production build configuration review |
| No automated public contribution checks | Add SHA-pinned CI actions, frozen dependency install without lifecycle scripts, tests/typecheck/build/audit, Gitleaks and CodeQL; add Dependabot | Local clean install and build; GitHub checks are the publication gate |

## Areas reviewed

- **Backend authorization:** rooms use separate host and guest credentials;
  paired rendezvous verifies the intended side's hashed credential. Confirmation
  is restricted to the recipient. Revocation deletes the pair and pending rooms.
  Return validators omit private credentials. This is capability-based access,
  not account authentication; absence of `getUserIdentity()` is intentional.
- **Data minimization:** file bytes, filenames, device names, and public keys
  travel through the data channel. Convex retains connection metadata and pair
  capabilities. Scheduled internal functions delete expired records. Mutation
  authorization checks expiration; query subscriptions rely on scheduled deletion
  and clients also check expiration. Scheduler delay can extend metadata retention.
- **Resource controls:** bounded SDP/candidates, indexed lookups, 20-pair request
  limit, shared transactional creation buckets, bounded file/selection sizes,
  chunk windows, queue limits, timeout/cancellation handling and receiver approval.
- **Cryptography:** browser-generated non-exportable P-256 keys; 256-bit random
  capabilities; SHA-256 token hashes; fresh challenges bound to WebRTC certificate
  fingerprints. Tests reject substituted keys, replayed challenges, and changed
  connection bindings. The HTTP SHA-256 fallback is checked against Web Crypto.
- **Filesystem and presentation:** React text escaping, no HTML injection sinks,
  filename/path validation, isolated receive subfolders, numbered disk names,
  ZIP path sanitization, retained-download limits, partial-file cleanup and
  confirmation only after successful writes. Downloaded contents are not scanned.
- **Supply chain/publication:** exact runtime dependency versions, lockfile
  integrity, no new application dependencies, no install scripts in CI, no
  production deployment step or secrets in workflows. Source-only export excludes
  `.git`, all local environment/backup files, Convex database/state, Vercel project
  configuration, screenshots, dependencies and build outputs.

## Checks performed

- 46 Node tests passed, including malicious protocol inputs, pre-approval data,
  incomplete transfers, forged acknowledgments, identity substitution, replay,
  slow storage, cancellation, repeat approval, safe MIME and queue flooding.
- TypeScript and optimized Next.js build passed in the working tree and a clean
  snapshot installed from the frozen lockfile with lifecycle scripts disabled.
- Isolated loopback Convex deployment compiled and passed lifecycle/access tests,
  including wrong host/guest/pair credentials, unauthorized close and candidate
  writes, oversized candidates, the 40-candidate cap, duplicate joins, mutual
  approval and revocation. Abuse tests verified rotating IDs cannot bypass global
  creation limits and rejected transactions leave no records. Test data cleaned up.
- Production-build Chrome smoke test used separate browser contexts and a local
  backend: temporary room, fragment invite, receiver approval, exact content,
  generic download MIME, a second separately approved collection, mutual pairing,
  live revocation, and rejection of an extra peer-created channel.
- `pnpm audit` reported zero known advisories across 122 resolved dependencies.
- Gitleaks 8.30.1 found no secrets in the initial source snapshot. The executable
  was downloaded from the official release and checked against its SHA-256 list.
  CI scans Git history with a checksum-pinned executable.

## Residual risks and limits

No independent audit, mobile-device matrix, production infrastructure audit,
provider-log inspection, or distributed load test was performed. No abuse tests
ran against the hosted service. A clean dependency/secret scan is point-in-time
evidence and cannot prove the absence of vulnerabilities or unknown secrets.

Temporary room codes provide 40 bits of entropy and are bearer capabilities.
Read attempts are not rate limited by the application; creation quotas neither
prevent metadata guessing attempts nor provide DDoS protection or a spending cap.
Compare safety codes through a trusted channel for initial connections. Initial
peer identity cannot be established merely by encrypting transport. Paired-device
connections additionally pin keys. A peer that has an approved connection can
still consume bandwidth or stall; application limits mitigate browser resource
use but do not impose network-level isolation.

CSP provides framing/base/object controls, not a strict script policy. HTTP LAN
mode does not authenticate application delivery. Use HTTPS for sensitive data.
Offline browsers may not immediately observe revocation. Scheduled expiry is
not guaranteed instantaneous deletion or a policy for provider backups/logs.
See [SECURITY.md](../SECURITY.md) for operating and reporting guidance.
