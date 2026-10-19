/**
 * Offline tests for service account (JSON key) authentication.
 *
 * Generates a real RSA key pair, runs a mock OAuth2 token endpoint and a mock
 * Vertex SSE endpoint, and drives the adapter through a full request. No
 * network access and no real credentials are involved.
 *
 *   node test/service-account.test.mjs
 */
import assert from 'node:assert/strict'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GeminiArgonAdapter, resolveOptions, serviceAccountAuth } from 'dsh-gemini-argon'

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

let port
let tokenRequests = 0
let vertexRequests = 0
let lastAuthorization = ''
let failNextVertex = false

const sse = (event) => `data: ${JSON.stringify(event)}\n\n`

const server = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/token') {
    tokenRequests += 1
    let body = ''
    for await (const chunk of request) body += chunk
    const params = new URLSearchParams(body)
    assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer')

    const assertion = params.get('assertion')
    const [header, claims, signature] = assertion.split('.')
    assert.equal(
      createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url')),
      true,
      'JWT signature must verify with the generated public key',
    )
    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
    const decodedClaims = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'))
    assert.equal(decodedHeader.alg, 'RS256')
    assert.equal(decodedHeader.kid, 'kid-test')
    assert.equal(decodedClaims.iss, 'svc@demo.iam.gserviceaccount.com')
    assert.equal(decodedClaims.scope, CLOUD_PLATFORM_SCOPE)
    assert.equal(decodedClaims.aud, `http://127.0.0.1:${port}/token`)
    assert.ok(decodedClaims.exp > decodedClaims.iat)

    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      access_token: `sa-token-${tokenRequests}`,
      expires_in: 3600,
      token_type: 'Bearer',
    }))
    return
  }

  if (request.method === 'POST' && request.url.startsWith('/v1/projects/demo-project/locations/global/publishers/google/models/gemini-4-argon:streamGenerateContent')) {
    vertexRequests += 1
    lastAuthorization = request.headers.authorization ?? ''
    request.resume()
    if (failNextVertex) {
      failNextVertex = false
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 401, message: 'token expired' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'hello-sa' }] } }] }))
    response.write(sse({
      candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
    }))
    response.end()
    return
  }

  response.writeHead(404)
  response.end('not found')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
port = server.address().port

const serviceAccount = {
  type: 'service_account',
  project_id: 'demo-project',
  private_key_id: 'kid-test',
  private_key: privateKey,
  client_email: 'svc@demo.iam.gserviceaccount.com',
  token_uri: `http://127.0.0.1:${port}/token`,
}

const config = resolveOptions({
  auth: 'service-account',
  serviceAccountJson: JSON.stringify(serviceAccount),
  baseURL: `http://127.0.0.1:${port}`,
  proxy: 'direct',
})

assert.equal(config.project, 'demo-project', 'project_id must fill an unset project')
assert.equal(config.auth, 'service-account')

const adapter = new GeminiArgonAdapter({
  options: () => config,
  resolveAuth: (force) => serviceAccountAuth(config, force),
})

const run = async () => {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'gemini-argon',
    model: 'gemini-4-argon',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    chunks.push(chunk)
  }
  return chunks
}

const first = await run()
assert.equal(first.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'hello-sa')
assert.deepEqual(first.at(-1).reason, { kind: 'stop' })
assert.equal(lastAuthorization, 'Bearer sa-token-1')
assert.equal(tokenRequests, 1)
assert.equal(vertexRequests, 1)

const second = await run()
assert.equal(second.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'hello-sa')
assert.equal(tokenRequests, 1, 'a cached token must be reused across requests')

failNextVertex = true
const third = await run()
assert.equal(tokenRequests, 2, 'a 401 must force one token refresh')
assert.equal(lastAuthorization, 'Bearer sa-token-2')
assert.equal(vertexRequests, 4)

const directory = mkdtempSync(join(tmpdir(), 'dsh-gemini-argon-'))
try {
  const file = join(directory, 'service-account.json')
  writeFileSync(file, JSON.stringify(serviceAccount))
  const fromFile = resolveOptions({
    serviceAccountFile: file,
    baseURL: `http://127.0.0.1:${port}`,
    proxy: 'direct',
  })
  assert.equal(fromFile.auth, 'service-account')
  assert.equal(fromFile.project, 'demo-project')
  assert.equal(fromFile.serviceAccount.clientEmail, 'svc@demo.iam.gserviceaccount.com')

  const forcedApiKey = resolveOptions({
    auth: 'api-key',
    project: 'explicit-project',
    serviceAccountFile: file,
    proxy: 'direct',
  })
  assert.equal(forcedApiKey.auth, 'api-key')
  assert.equal(forcedApiKey.project, 'explicit-project')
} finally {
  rmSync(directory, { recursive: true, force: true })
}

server.close()
console.log('service-account tests passed')
