# dsh-opencode-free-tier

Free OpenCode Zen models inside DeepSeek Harness (DSH) via the stock `llm-pi-ai` adapter — no API key, no extra provider plugin.

## The problem

Since 2026-09-16, OpenCode Zen's anonymous free lane rejects every request that doesn't look like traffic from the OpenCode CLI:

```
403: {"type":"FreeTierError","message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}
```

Live-probed 2026-09-18, the gate has three parts — **all** must hold:

1. `User-Agent` starts with `opencode/`
2. `x-opencode-session` is `ses_` + 26 chars (12 lowercase hex + 14 Base62)
3. the chat body streams (`stream: true`) with function tools named `bash` **and** `read`

DSH's `llm-pi-ai` `opencode` route sends none of the three (UA `deepseek-harness/...`,
the DSH session id, no tools on plain chats), so every free-model call fails — while
OpenCode CLI works keyless. No login and no key are required; the anonymous lane key
is the literal string `public`.

## What this plugin does

A zero-dependency Cordis plugin that fixes all three at the fetch transport layer:

- **`llm/stream` waterfall observer** — carries `GenerateOptions.sessionId` in an
  `AsyncLocalStorage` across each adapter stream, so the fetch layer knows which DSH
  conversation a request belongs to (stable session → optimal upstream prompt-cache routing).
- **Fetch middleware, scoped strictly to `opencode.ai`** (+ subdomains) — every other
  host passes through byte-for-byte untouched:
  - missing/non-CLI `User-Agent` → `opencode/<cli-version> (platform arch; node...)`
  - missing/malformed `x-opencode-session` → canonicalized (`ses_` + 26) from the DSH
    conversation id; an already-canonical id passes through (cache affinity preserved)
  - fills `x-opencode-client: cli`, `x-session-affinity`, `X-Session-Id`,
    `x-opencode-request`, `x-opencode-project` when absent
  - chat-completions bodies missing `bash`/`read` tools get the stubs appended
    (`tool_choice: "none"` when the caller had no tools, so the model never calls them)

Already-correct requests pass through untouched (idempotent) — e.g. it coexists with
`opencode2dsh` instead of breaking it.

It supersedes `dsh-opencode-session-header`, which only stamped a **non-canonical**
session (no UA, no tools) and actively breaks canonical sessions by overwriting them.
Remove that plugin when installing this one.

## Requirements

- DSH (`DeepSeek Harness`) with a `web` profile; Node.js ≥ 20 (already present if DSH runs)
- Outbound HTTPS to `opencode.ai`

## Install

### Option A — from npm (recommended)

```sh
dsh plugin --profile web add dsh-opencode-free-tier
```

then register the bundle in `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-opencode-free-tier",
        "dsh-file-upload"
      ]
    }
  }
}
```

### Option B — from git

```sh
cd ~/.dsh/profiles/web
pnpm add github:<owner>/dsh-opencode-free-tier
```

then register the bundle as above.

### Option C — from a local clone

```sh
git clone https://github.com/<owner>/dsh-opencode-free-tier.git
cd ~/.dsh/profiles/web
pnpm add file:/path/to/dsh-opencode-free-tier
```

then register the bundle as above.

Finally:

```sh
cd ~/.dsh/profiles/web
pnpm install
```

Remove `dsh-opencode-session-header` from `dependencies` + `bundles` if present,
then **restart `dsh web`** once — plugins load at boot.

## Configure the free route

No API key needed. In `~/.dsh/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    opencode:
      headers:
        Authorization: Bearer public
```

Then pick any free model from the `opencode` route (e.g. `mimo-v2.5-free`,
`deepseek-v4-flash-free`, `ling-3.0-flash-fin-free`, `nemotron-3-ultra-free`).

## Verify

```sh
curl -s -X POST https://opencode.ai/zen/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer public" \
  -H "User-Agent: deepseek-harness/0.1.0 test" \
  -d '{"model":"mimo-v2.5-free","messages":[{"role":"user","content":"hi"}],"stream":true,"max_completion_tokens":10}' \
  --max-time 20 | head -c 300
```

- Without the plugin: `FreeTierError`.
- With the plugin (restart DSH, chat with the model): normal streamed chunks.

Or run the plugin's own tests (no key needed for unit tests):

```sh
node --test test/
```

## Runtime switch (no restart needed)

State file: `~/.dsh/plugins/dsh-opencode-free-tier.json` (defaults to `~/.dsh`,
or `$DSH_HOME` when set):

```json
{ "enabled": false }
```

- `false` → everything passes through untouched
- `true` or **file missing** → fixing on
- re-read on every matching request

Plugin config in `cordis.patch.yml` also accepts `{ hosts?, enabled? }`.

## How it works

```
DSH llm-pi-ai (opencode route)
  │  pi-ai openai-completions stream
  ▼  global fetch
dsh-opencode-free-tier middleware (opencode.ai only)
  │  UA → opencode/…  ·  session → ses_+26  ·  tools → +bash/+read
  ▼
https://opencode.ai/zen/…   Authorization: Bearer public
```

Session derivation mirrors the CLI: `SHA-256("ses\0" + DSH-session-id)` →
`ses_` + 6 bytes hex + 10 bytes Base62. The same conversation keeps a stable
session; different conversations separate (same scheme as `opencode2dsh`, so a
mixed setup shares cache affinity).

## Testing

```sh
node --test test/free-tier.test.mjs
```

Covers: canonical session passthrough/hashing, CLI UA shape, tool injection +
idempotence, middleware fixing a DSH-like request while preserving an
already-correct one and leaving foreign hosts untouched.

## Compatibility & retirement

- Verified against DSH `0.1.2-rc.1` and `@earendil-works/pi-ai` `0.85.x`.
- Depends on DSH outbound LLM traffic using the process-global `fetch`. If a future
  DSH build changes its network stack, the plugin silently stops fixing — the symptom
  is simply the `403` returning; uninstall then.
- If upstream DSH ever ships native CLI disguise for the free lane, retire this plugin:
  remove it from `dependencies` + `bundles`, `pnpm install`, restart.

## License

[MIT](./LICENSE)

## Release process (maintainers)

Publishing uses [npm trusted publishing (OIDC)](https://docs.npmjs.com/trusted-publishers) —
no tokens, no OTP. One-time setup on npmjs.com → package → Settings →
Trusted Publisher: GitHub Actions, user `DOCUTEE`, repository
`dsh-opencode-free-tier`, workflow `publish.yml`, allowed action `npm publish`.

To release:

```sh
# 1. bump version in package.json (must match the tag below)
# 2. commit, then:
git tag v0.1.0 && git push origin v0.1.0
```

Pushing the tag runs `.github/workflows/publish.yml`, which runs tests and
`npm publish`es. Provenance is generated automatically.
