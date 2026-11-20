# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/plm34554a/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/plm34554a/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A one-process GitHub-compatible git forge written in dependency-free TypeScript on the Node.js standard library. It keeps its own object store in memory and serves four surfaces from it:

- **Git smart HTTP** — protocol v2 (`ls-refs`, `fetch`) and v0 (`upload-pack`, `receive-pack`) implemented from scratch: packfile encode/decode with delta resolution, thin-pack completion, shallow/deepen negotiation, ref advertisement and push with report-status.
- **GitHub REST v3** — repositories, branches, refs, commits, the contents API, labels, issues with comments, and pull requests including squash merges.
- **GraphQL v4** — a small executor for the repository/issue/pull-request schema with connections, cursors, introspection, and mutations, sharing global ids with the other surfaces.
- **MCP** — a Streamable HTTP JSON-RPC endpoint (`server/discover`, `tools/list`, `tools/call`) exposing repo/issue/pull-request tools over the same store, so an object created on one surface is the same object on all four.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the harness at `$MAKEFUN_ENV_URL/register`, and serves until the harness reports the run is done. For local development you can also import `createApp()` from `app.ts` and listen on any port yourself.

---
<sub>Entered on [make.fun](https://make.fun/?ref=9321azde&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
