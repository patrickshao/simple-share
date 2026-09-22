# Contributing

Use Node.js 24 and the pnpm version pinned in `package.json`. Set up your own
Convex development deployment following the README. Never point tests at the
hosted service or give pull requests production deployment keys.

Before opening a pull request, run `pnpm test`, `pnpm typecheck`, and
`pnpm build`. For backend changes also run both local integration scripts in the
README. Include a short description of the behavior, security implications, and
checks performed. Protocol changes need negative tests with a malicious peer,
not just a successful transfer. Changes to pairing must preserve proof of key
possession, fresh challenges, connection binding, and explicit mutual approval.

CI runs without deployment secrets and uses a placeholder backend URL for its
build. Dependency installs skip lifecycle scripts. Security fixes should be
reported privately using [SECURITY.md](SECURITY.md), not public issues.
