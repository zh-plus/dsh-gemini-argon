/**
 * Offline tests for image input, cross-provider tool-call degradation, and the
 * stream idle timeout. A local HTTP server plays Vertex AI; no credentials or
 * network access are involved.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { GeminiArgonAdapter, buildRequestBody, resolveOptions } from 'dsh-gemini-argon'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUElEQVR42u3PQQkAAAgEsEvi2/55DGME38JgBZapfi0CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApcFEWchD98r0aIAAAAASUVORK5CYII=',
  'base64',
)

const sse = (event) => `data: ${JSON.stringify(event)}\n\n`
const requests = []

const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  requests.push({ url: request.url, body: body.length > 0 ? JSON.parse(body) : undefined })
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] }))
  response.write(sse({ candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }] }))
  response.end()
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const config = resolveOptions({
  project: 'demo-project',
  baseURL: `http://127.0.0.1:${port}`,
  proxy: 'direct',
  imageMaxPixels: 1_000_000,
  imageMaxBytes: 1_000_000,
})

let lastTarget
const attachments = {
  readImageRequest(ref, target) {
    lastTarget = target
    return Promise.resolve({
      mediaType: 'image/png',
      data: PNG,
      bytes: PNG.byteLength,
      width: 64,
      height: 64,
    })
  },
}

const adapter = new GeminiArgonAdapter({
  options: () => config,
  resolveAuth: async () => ({ kind: 'api-key', headers: { 'x-goog-api-key': 'test-key' } }),
  resolveAttachments: () => attachments,
})

const run = async (messages, signal) => {
  for await (const _chunk of adapter.stream({
    provider: 'gemini-argon',
    model: 'gemini-4-argon',
    messages,
    signal,
  })) {
    // drain
  }
}

// 1. Image input is serialized as Gemini inlineData.
await run([{
  role: 'user',
  content: [
    { type: 'text', text: 'What color is this image?' },
    { type: 'image', attachment: { attachmentId: 'sha256:red', mediaType: 'image/png', width: 64, height: 64, bytes: PNG.byteLength } },
  ],
}])

const imageBody = requests.at(-1).body
const imagePart = imageBody.contents[0].parts.find((part) => part.inlineData !== undefined)
assert.ok(imagePart, 'the request must contain an inlineData part')
assert.equal(imagePart.inlineData.mimeType, 'image/png')
assert.equal(imagePart.inlineData.data, PNG.toString('base64'))
assert.deepEqual(lastTarget, { width: 64, height: 64, maxBytes: 1_000_000 })

const largeTarget = adapter.imageRequestTarget('gemini-argon', 'gemini-4-argon', { width: 4000, height: 3000 })
assert.ok(largeTarget.width * largeTarget.height <= 1_000_000, 'imageRequestTarget must honor imageMaxPixels')
assert.ok(Math.abs(largeTarget.width / largeTarget.height - 4 / 3) < 0.02, 'aspect ratio must be preserved')

// 2. A tool call produced by another provider has no Gemini signature; it must
//    be projected as text instead of a functionCall part.
const unsignedHistory = [
  { role: 'user', content: [{ type: 'text', text: 'Use the add tool to add 2 and 3.' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Calling add.' },
      { type: 'tool-call', id: 'call-foreign', name: 'add', arguments: '{"a":2,"b":3}' },
    ],
  },
  { role: 'tool', toolCallId: 'call-foreign', content: [{ type: 'text', text: '5' }] },
  { role: 'user', content: [{ type: 'text', text: 'What was the result?' }] },
]
await run(unsignedHistory)
const degradedBody = requests.at(-1).body
const serialized = JSON.stringify(degradedBody)
assert.equal(serialized.includes('"functionCall"'), false, 'unsigned calls must not become functionCall parts')
assert.ok(serialized.includes('Tool call add'), 'the call must be described as text')
assert.ok(serialized.includes('Tool result from add: 5'), 'the result must be described as text')

// 2b. A signed tool result keeps functionResponse and inline data in separate
//     turns; Vertex rejects them combined.
const signedHistory = [
  { role: 'user', content: [{ type: 'text', text: 'Capture the screen.' }] },
  {
    role: 'assistant',
    source: {
      kind: 'model',
      provider: 'gemini-argon',
      model: 'gemini-4-argon',
      replayState: {
        kind: 'gemini-argon',
        version: 1,
        parts: [{ functionCall: { name: 'screenshot', args: {}, id: 'call-signed' }, thoughtSignature: 'sig' }],
        blocks: [{ signature: 'sig' }],
      },
    },
    content: [{ type: 'tool-call', id: 'call-signed', name: 'screenshot', arguments: '{}' }],
  },
  {
    role: 'tool',
    toolCallId: 'call-signed',
    content: [
      { type: 'text', text: 'captured' },
      { type: 'image', attachment: { attachmentId: 'sha256:red', mediaType: 'image/png', width: 64, height: 64, bytes: PNG.byteLength } },
    ],
  },
  { role: 'user', content: [{ type: 'text', text: 'What color is it?' }] },
]
await run(signedHistory)
const signedBody = requests.at(-1).body
const signedUserTurns = signedBody.contents.filter((turn) => turn.role === 'user')
const responseTurn = signedUserTurns.find((turn) => turn.parts.some((part) => part.functionResponse !== undefined))
assert.ok(responseTurn, 'the tool result must produce a functionResponse turn')
assert.equal(responseTurn.parts.some((part) => part.inlineData !== undefined), false, 'functionResponse turns must not carry inline data')
const imageTurn = signedUserTurns.find((turn) => turn.parts.some((part) => part.inlineData !== undefined))
assert.ok(imageTurn, 'the tool image must be sent in its own user turn')
assert.ok(imageTurn.parts.some((part) => typeof part.text === 'string' && part.text.includes('What color')), 'the following user text may share the image turn')

// 3. Thinking: "off" pins the minimum level Gemini 4 Argon supports and hides
//    thoughts; explicit levels ask for the thought summaries.
const simple = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
assert.deepEqual(buildRequestBody(simple, config).generationConfig.thinkingConfig, { thinkingLevel: 'LOW' })
assert.deepEqual(
  buildRequestBody(simple, { ...config, thinkingLevel: 'low' }).generationConfig.thinkingConfig,
  { thinkingLevel: 'LOW', includeThoughts: true },
)
assert.deepEqual(
  buildRequestBody(simple, { ...config, thinkingLevel: 'high' }).generationConfig.thinkingConfig,
  { thinkingLevel: 'HIGH', includeThoughts: true },
)

// 4. A provider that accepts the request but never streams fails as TIMEOUT.
const slow = createServer((_request, _response) => {
  // Deliberately never respond.
})
await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve))
const slowPort = slow.address().port
try {
  const slowConfig = resolveOptions({
    project: 'demo-project',
    baseURL: `http://127.0.0.1:${slowPort}`,
    proxy: 'direct',
    streamIdleTimeoutMs: 300,
  })
  const slowAdapter = new GeminiArgonAdapter({
    options: () => slowConfig,
    resolveAuth: async () => ({ kind: 'api-key', headers: { 'x-goog-api-key': 'test-key' } }),
  })
  let failure
  try {
    for await (const _chunk of slowAdapter.stream({
      provider: 'gemini-argon',
      model: 'gemini-4-argon',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      signal: AbortSignal.timeout(5000),
    })) {
      // drain
    }
  } catch (error) {
    failure = error
  }
  assert.ok(failure, 'the stalled request must fail')
  assert.equal(failure.code, 'TIMEOUT')
} finally {
  slow.closeAllConnections?.()
  slow.close()
  server.close()
}

console.log('image, degradation, and timeout tests passed')
