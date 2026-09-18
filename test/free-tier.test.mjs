import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  CANONICAL_SESSION_PATTERN,
  canonicalSessionID,
  opencodeUserAgent,
  ensureFreeLaneShape,
  createFreeTierMiddleware,
  requestSessionContext,
} from '../lib/index.js'

test('canonical session: passthrough + hash', () => {
  const good = 'ses_abcdef123456ABCDEFGHIJKLMN'
  assert.match(good, CANONICAL_SESSION_PATTERN)
  assert.equal(canonicalSessionID(good), good)
  const hashed = canonicalSessionID('my-dsh-session-123')
  assert.match(hashed, CANONICAL_SESSION_PATTERN)
  assert.equal(hashed, canonicalSessionID('my-dsh-session-123'), 'stable per signal')
  assert.ok(!CANONICAL_SESSION_PATTERN.test('dsh-default'))
  assert.match(canonicalSessionID('dsh-default'), CANONICAL_SESSION_PATTERN)
})

test('UA looks like CLI', () => {
  const ua = opencodeUserAgent()
  assert.ok(ua.startsWith('opencode/'), ua)
})

test('ensureFreeLaneShape injects bash+read once', () => {
  const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }
  const fixed = ensureFreeLaneShape(base)
  assert.ok(fixed)
  assert.equal(fixed.tools.length, 2)
  assert.equal(fixed.tool_choice, 'none')
  assert.equal(fixed.stream, true)
  assert.equal(ensureFreeLaneShape(fixed), undefined, 'idempotent')
  const partial = { ...base, tools: [{ type: 'function', function: { name: 'bash', description: 'x', parameters: { type: 'object', properties: {} } } }] }
  const fixed2 = ensureFreeLaneShape(partial)
  assert.equal(fixed2.tools.length, 2)
  assert.equal(fixed2.tool_choice, undefined, 'preserve client tools choice')
})

test('middleware fixes DSH-like request, preserves opencode2dsh request', async () => {
  const mw = createFreeTierMiddleware({ hosts: ['opencode.ai'], isEnabled: () => true })
  let captured
  const next = async (input, init) => {
    captured = { input, init }
    return 'ok'
  }
  // DSH-like: bad UA, bad session, no tools
  await requestSessionContext.run('dsh-session-abc', () =>
    mw({
      input: 'https://opencode.ai/zen/chat/completions',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'deepseek-harness/0.1.0', 'x-opencode-session': 'dsh-session-abc' },
        body: JSON.stringify({ model: 'mimo-v2.5-free', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      },
      next,
    }),
  )
  const h = new Headers(captured.init.headers)
  assert.ok(h.get('user-agent').startsWith('opencode/'), h.get('user-agent'))
  assert.match(h.get('x-opencode-session'), CANONICAL_SESSION_PATTERN)
  const body = JSON.parse(captured.init.body)
  assert.equal(body.tools.length, 2)
  assert.equal(body.tool_choice, 'none')

  // opencode2dsh-like: already correct -> untouched session + tools
  const goodSession = 'ses_abcdef123456ABCDEFGHIJKLMN'
  const goodBody = JSON.stringify({
    model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true,
    tools: [
      { type: 'function', function: { name: 'bash', description: 'x', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'read', description: 'x', parameters: { type: 'object', properties: {} } } },
    ],
  })
  await mw({
    input: 'https://opencode.ai/zen/chat/completions',
    init: { method: 'POST', headers: { 'user-agent': 'opencode/1.18.31 (x)', 'x-opencode-session': goodSession }, body: goodBody },
    next,
  })
  const h2 = new Headers(captured.init.headers)
  assert.equal(h2.get('x-opencode-session'), goodSession, 'preserve canonical session')
  assert.equal(captured.init.body, goodBody, 'preserve good body')

  // non-opencode host untouched
  const origHeaders = { 'user-agent': 'deepseek-harness/0.1.0' }
  await mw({ input: 'https://api.deepseek.com/chat/completions', init: { headers: origHeaders, body: '{}' }, next })
  assert.deepEqual(captured.init.headers, origHeaders)
})
