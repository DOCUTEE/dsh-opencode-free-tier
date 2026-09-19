/**
 * dsh-opencode-free-tier — make every DSH request to OpenCode Zen look like
 * OpenCode CLI so the anonymous free lane passes its gate.
 *
 * Live-probed 2026-09-18 (see README): Zen free tier returns
 * 403 FreeTierError unless ALL three hold:
 *   1. `User-Agent` starts with `opencode/`
 *   2. `x-opencode-session` is `ses_` + 26 chars (12 lowercase hex + 14 Base62)
 *   3. chat body streams with function tools named `bash` AND `read`
 *
 * DSH's `llm-pi-ai` opencode route sends none of the three (UA is
 * `deepseek-harness/...`, session is the DSH id, plain chats carry no tools),
 * so every free-model call fails. The `opencode2dsh` adapter already spoofs
 * all three — this plugin fixes the generic `llm-pi-ai` path at the fetch
 * transport layer, and leaves already-correct requests (opencode2dsh)
 * byte-for-byte untouched (idempotent).
 *
 * Scope: `opencode.ai` (+ subdomains) only. Every other host passes through.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

/** Cordis plugin name (the Loader entry). */
export const name = 'dsh-opencode-free-tier'

/** Services required before load: none — llm/stream is an optional observer. */
export const inject = []

/** Carries the DSH session id across one llm/stream call. */
export const requestSessionContext = new AsyncLocalStorage()

const HEADER_SESSION = 'x-opencode-session'
const DEFAULT_HOSTS = ['opencode.ai']

/** Canonical CLI session shape: `ses_` + 12 hex + 14 Base62 (= 26). */
export const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function base62Fixed(value, width) {
  const base = 62n
  let n = value
  const out = new Array(width)
  for (let i = width - 1; i >= 0; i--) {
    out[i] = BASE62_ALPHABET.charAt(Number(n % base))
    n /= base
  }
  return out.join('')
}

/**
 * Canonicalize any signal into the CLI session shape. An already-canonical
 * id passes through unchanged (preserves upstream prompt-cache affinity);
 * anything else (DSH session id, fallback, probe) is deterministically hashed.
 */
export function canonicalSessionID(signal) {
  if (typeof signal === 'string' && CANONICAL_SESSION_PATTERN.test(signal)) return signal
  const sum = createHash('sha256').update('ses\0' + String(signal)).digest()
  return `ses_${sum.subarray(0, 6).toString('hex')}${base62Fixed(BigInt('0x' + sum.subarray(6, 16).toString('hex')), 14)}`
}

function randomID(prefix, size) {
  return `${prefix}_${randomBytes(size).toString('hex')}`
}

function stableID(prefix, value) {
  return `${prefix}_${createHash('sha256').update(prefix + '\0' + value).digest().subarray(0, 12).toString('hex')}`
}

/** Stable default project id (same derivation as opencode2dsh). */
function defaultProjectID() {
  return stableID('prj', 'opencode2dsh:default-project')
}

/** CLI-identical user agent. */
export function opencodeUserAgent() {
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`
}

// ---------------------------------------------------------------------------
// fetch pipeline (own symbol so coexisting plugins never clobber each other)
// ---------------------------------------------------------------------------

const FETCH_PIPELINE_KEY = Symbol.for('dsh-opencode-free-tier.fetch.pipeline.v1')

function ensureFetchPipeline() {
  const g = globalThis
  if (g[FETCH_PIPELINE_KEY]) return g[FETCH_PIPELINE_KEY]
  let underlyingFetch = globalThis.fetch
  const state = {
    getUnderlyingFetch: () => underlyingFetch,
    setUnderlyingFetch: (nextFetch) => {
      underlyingFetch = nextFetch
    },
    middlewares: [],
    installed: false,
    patchedFetch: undefined,
  }
  g[FETCH_PIPELINE_KEY] = state
  return state
}

function compose(state) {
  const ordered = [...state.middlewares].sort((a, b) => a.priority - b.priority)
  const callAt = (index, input, init) => {
    if (index >= ordered.length) return state.getUnderlyingFetch()(input, init)
    const current = ordered[index]
    return current.middleware({
      input,
      init,
      next: (nextInput, nextInit) => callAt(index + 1, nextInput, nextInit),
    })
  }
  return (input, init) => callAt(0, input, init)
}

function installFetchPipeline() {
  const state = ensureFetchPipeline()
  if (state.installed) {
    state.patchedFetch = compose(state)
    return
  }
  const prevDesc = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  state.patchedFetch = compose(state)
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    enumerable: prevDesc?.enumerable ?? true,
    get() {
      return state.patchedFetch
    },
    set(newFetch) {
      if (newFetch === state.patchedFetch) return
      try {
        prevDesc?.set?.call(globalThis, newFetch)
      } catch {}
      state.setUnderlyingFetch(newFetch)
      state.patchedFetch = compose(state)
    },
  })
  state.installed = true
}

export function registerFetchMiddleware(registration) {
  const state = ensureFetchPipeline()
  const existingIndex = state.middlewares.findIndex((m) => m.name === registration.name)
  if (existingIndex >= 0) state.middlewares.splice(existingIndex, 1, registration)
  else state.middlewares.push(registration)
  installFetchPipeline()
}

export function unregisterFetchMiddleware(mwName) {
  const state = ensureFetchPipeline()
  const index = state.middlewares.findIndex((m) => m.name === mwName)
  if (index >= 0) state.middlewares.splice(index, 1)
  if (state.installed) state.patchedFetch = compose(state)
}

// ---------------------------------------------------------------------------
// request helpers
// ---------------------------------------------------------------------------

function requestUrlOf(input) {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input && typeof input === 'object' && typeof input.url === 'string') return new URL(input.url)
  } catch {}
  return undefined
}

export function hostMatches(hostname, hosts) {
  const h = String(hostname ?? '').toLowerCase()
  return hosts.some((entry) => {
    const target = String(entry).toLowerCase().trim()
    if (!target) return false
    return h === target || h.endsWith(`.${target}`)
  })
}

// ---------------------------------------------------------------------------
// free-lane body shape (port of opencode2dsh ensureFreeLaneShape)
// ---------------------------------------------------------------------------

const FREE_LANE_GATE_TOOL_NAMES = ['bash', 'read']

function freeLaneGateTool(toolName) {
  return {
    type: 'function',
    function: {
      name: toolName,
      description: 'Reserved for the host runtime; do not call it.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  }
}

/**
 * Rewrite an outgoing chat-completions payload so it satisfies the free-lane
 * agent-shape gate. Appends only the gate tools the payload is missing; when
 * the context carried no tools at all, `tool_choice: 'none'` keeps the model
 * from ever calling the injected stubs. Returns the new body object, or
 * `undefined` when the payload already satisfies the gate or is not a
 * chat-completions body (caller keeps the original in that case).
 */
export function ensureFreeLaneShape(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const body = payload
  if (!Array.isArray(body.messages)) return undefined
  const tools = Array.isArray(body.tools) ? body.tools : []
  const names = new Set(
    tools.map((tool) => {
      const fn = typeof tool === 'object' && tool !== null ? tool.function : undefined
      return typeof fn === 'object' && fn !== null ? fn.name : undefined
    }),
  )
  const missing = FREE_LANE_GATE_TOOL_NAMES.filter((toolName) => !names.has(toolName))
  if (missing.length === 0) return undefined
  const next = { ...body }
  next.tools = [...tools, ...missing.map((toolName) => freeLaneGateTool(toolName))]
  if (tools.length === 0) next.tool_choice = 'none'
  // The gate also has a streaming half; pi-ai always streams, but enforce it
  // for any other client that reaches this layer without it.
  if (next.stream !== true) next.stream = true
  return next
}

async function readBodyText(input, init) {
  if (init && init.body !== undefined) {
    const b = init.body
    if (typeof b === 'string') return b
    // URLSearchParams / FormData / Blob / ArrayBuffer etc: not JSON chat bodies.
    return undefined
  }
  try {
    if (input && typeof input === 'object' && typeof input.clone === 'function' && typeof input.text === 'function') {
      const method = String(input.method ?? 'GET').toUpperCase()
      if (method === 'GET' || method === 'HEAD') return undefined
      const ct = input.headers?.get?.('content-type') ?? ''
      if (ct && !ct.includes('json')) return undefined
      return await input.clone().text()
    }
  } catch {}
  return undefined
}

// ---------------------------------------------------------------------------
// middleware + llm/stream listener factories (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Build the fetch middleware.
 * Options:
 *   - hosts: allowlist (default opencode.ai)
 *   - isEnabled: () => boolean, consulted per matching request
 *
 * Two lanes share the host:
 *   - the anonymous free lane (`/zen/...`) needs the full CLI disguise (UA,
 *     canonical session, `bash`/`read` tools) or it answers 403 FreeTierError;
 *   - the paid OpenCode Go lane (`/zen/go/...`) only needs the stable
 *     `x-opencode-session` header the Go docs ask for, and should keep the
 *     harness's real User-Agent, so it is never disguised and gets no tools.
 */
export function createFreeTierMiddleware(options) {
  const hosts = options?.hosts?.length ? options.hosts : DEFAULT_HOSTS
  const isEnabled = options?.isEnabled || (() => true)
  return async function freeTierMiddleware({ input, init, next }) {
    const url = requestUrlOf(input)
    if (!url || !hostMatches(url.hostname, hosts)) return next(input, init)
    if (!isEnabled()) return next(input, init)
    const freeLane = !url.pathname.startsWith('/zen/go/')

    // Merge whichever header source would actually reach the wire (fetch spec:
    // init.headers replaces Request headers when present).
    const source =
      init && init.headers !== undefined
        ? init.headers
        : input && typeof input === 'object' && input.headers
          ? input.headers
          : undefined
    const headers = new Headers(source ?? undefined)

    // 1. User-Agent must start with opencode/ (free lane only; Go keeps the
    // harness identity the Go docs ask clients to send).
    if (freeLane) {
      const ua = headers.get('user-agent')
      if (!ua || !ua.toLowerCase().startsWith('opencode/')) {
        headers.set('user-agent', opencodeUserAgent())
      }
    }

    // 2. x-opencode-session must be canonical ses_+26; preserve a correct one
    // (opencode2dsh already sets a canonical id — keep it for cache affinity).
    const existing = headers.get(HEADER_SESSION)
    let session
    if (existing && CANONICAL_SESSION_PATTERN.test(existing)) {
      session = existing
    } else {
      const store = requestSessionContext.getStore()
      const signal =
        typeof store === 'string' && store.length > 0 ? store : randomID('fallback', 16)
      session = canonicalSessionID(signal)
      headers.set(HEADER_SESSION, session)
    }
    if (freeLane) {
      if (!headers.get('x-opencode-client')) headers.set('x-opencode-client', 'cli')
      if (!headers.get('x-session-affinity')) headers.set('x-session-affinity', session)
      if (!headers.get('x-session-id') && !headers.get('X-Session-Id')) headers.set('X-Session-Id', session)
      if (!headers.get('x-opencode-request')) headers.set('x-opencode-request', randomID('req', 16))
      if (!headers.get('x-opencode-project')) headers.set('x-opencode-project', defaultProjectID())
    }

    // 3. Free lane only: body must carry bash+read tools (chat-completions shape).
    let newBodyText
    if (freeLane) {
      try {
        const bodyText = await readBodyText(input, init)
        if (typeof bodyText === 'string' && bodyText.length > 0) {
          let parsed
          try {
            parsed = JSON.parse(bodyText)
          } catch {
            parsed = undefined
          }
          const fixed = parsed === undefined ? undefined : ensureFreeLaneShape(parsed)
          if (fixed !== undefined) newBodyText = JSON.stringify(fixed)
        }
      } catch {}
    }

    if (newBodyText === undefined) {
      return next(input, { ...init, headers })
    }
    // init.body wins over Request body per fetch spec, so stamping the fixed
    // string there covers both string-URL and Request-object call shapes.
    return next(input, { ...init, headers, body: newBodyText })
  }
}

/**
 * Build the `llm/stream` waterfall listener: re-emits the downstream stream
 * with every iterator step executed inside AsyncLocalStorage carrying the
 * call's sessionId, so fetches issued while iterating inherit the context.
 */
export function createLlmStreamListener(sessionContext) {
  return function llmStreamObserver(llmOptions, next) {
    const sessionKey = String(llmOptions?.sessionId ?? '')
    const inner = next()
    const iterator = inner[Symbol.asyncIterator]()
    const doneResult = () => ({ done: true, value: undefined })
    const runNext = () => sessionContext.run(sessionKey, () => iterator.next())
    const runReturn = () =>
      sessionContext.run(sessionKey, () => (iterator.return ? iterator.return() : Promise.resolve(doneResult())))
    const runThrow = (err) =>
      sessionContext.run(sessionKey, () => (iterator.throw ? iterator.throw(err) : Promise.resolve(doneResult())))
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => runNext(),
          return: () => runReturn(),
          throw: (err) => runThrow(err),
        }
      },
    }
  }
}

// ---------------------------------------------------------------------------
// runtime switch (re-read per request; no restart needed)
// ---------------------------------------------------------------------------

export function switchFilePath() {
  const envHome = process.env.DSH_HOME?.trim()
  const home = envHome ? envHome : join(homedir(), '.dsh')
  return join(home, 'plugins', 'dsh-opencode-free-tier.json')
}

/** Missing/unreadable file or non-boolean `enabled` → seed (default true). */
export function readEnabledSwitch(seed = true) {
  try {
    const parsed = JSON.parse(readFileSync(switchFilePath(), 'utf8'))
    if (parsed && typeof parsed.enabled === 'boolean') return parsed.enabled
  } catch {}
  return seed
}

// ---------------------------------------------------------------------------
// cordis plugin surface
// ---------------------------------------------------------------------------

/**
 * Mount the plugin.
 * @param ctx - host cordis context.
 * @param config - optional deployment config: { hosts?, enabled? }.
 */
export function apply(ctx, config) {
  const cfg = config ?? {}
  const hosts = Array.isArray(cfg.hosts) && cfg.hosts.length ? cfg.hosts.map(String) : DEFAULT_HOSTS
  const seedEnabled = typeof cfg.enabled === 'boolean' ? cfg.enabled : true
  const isEnabled = () => readEnabledSwitch(seedEnabled)

  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(message)
    } catch {}
  }

  ctx.effect(() => {
    registerFetchMiddleware({
      name: 'dsh-opencode-free-tier-inject',
      priority: 6,
      middleware: createFreeTierMiddleware({ hosts, isEnabled }),
    })
    return () => {
      unregisterFetchMiddleware('dsh-opencode-free-tier-inject')
    }
  }, 'dsh-opencode-free-tier: fetch middleware')

  ctx.on('llm/stream', createLlmStreamListener(requestSessionContext))

  log('info', `[dsh-opencode-free-tier] loaded: hosts=${hosts.join(', ')} ua=${opencodeUserAgent()}`)
  log('info', `[dsh-opencode-free-tier] runtime switch: ${switchFilePath()} ({"enabled":false} disables; missing file = enabled)`)
}

export default apply
