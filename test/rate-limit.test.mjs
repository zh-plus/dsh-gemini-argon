/**
 * Offline test for the 429 retry cadence: three quick retries, then a minute.
 * A local server plays Vertex AI and always answers 429 until toggled.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { GeminiArgonAdapter, resolveOptions } from 'dsh-gemini-argon'

let fail = true
const server = createServer(async (request, response) => {
  for await (const _chunk of request) { /* drain */ }
  if (fail) {
    response.writeHead(429, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource exhausted. Please try again later.' } }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }] })}\n\n`)
  response.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const config = resolveOptions({
  project: 'demo-project',
  baseURL: `http://127.0.0.1:${port}`,
  proxy: 'direct',
  auth: 'api-key',
})
const adapter = new GeminiArgonAdapter({
  options: () => config,
  resolveAuth: async () => ({ kind: 'api-key', headers: { 'x-goog-api-key': 'test' } }),
})

const run = async (sessionId) => {
  try {
    for await (const _chunk of adapter.stream({
      provider: 'gemini-argon',
      model: 'gemini-4-argon',
      sessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) { /* drain */ }
  } catch (error) {
    return error
  }
  return undefined
}

const delays = []
for (let index = 0; index < 5; index += 1) {
  const error = await run('session-rate-limit')
  assert.ok(error, 'the 429 must surface as an error')
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(error.failure.providerRetryAfterMs, [2000, 5000, 10000, 60000, 60000][index])
  delays.push(error.failure.providerRetryAfterMs)
}

// A successful request resets the streak for that session.
fail = false
const ok = await run('session-rate-limit')
assert.equal(ok, undefined, 'the successful call must not throw')
fail = true
const afterReset = await run('session-rate-limit')
assert.equal(afterReset.failure.providerRetryAfterMs, 2000)

console.log('rate-limit cadence passed:', delays.join(', '), '→ reset 2000')
server.close()
