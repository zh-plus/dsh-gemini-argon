/**
 * Gemini 4 Argon (Google Vertex AI) provider plugin for DeepSeek Harness.
 *
 * The plugin registers one LLM route, `gemini-argon`, and talks to Vertex AI's
 * native `streamGenerateContent` API with either an Express API key
 * (`x-goog-api-key`) or a service account JSON key (RS256 JWT to OAuth2).
 * Text, images, streaming tool calls, usage accounting, and optional thinking
 * summaries are supported.
 *
 * Design notes:
 * - Express keys are region-scoped for the shorthand publisher path, so the
 *   request uses the explicit `projects/{project}/locations/{location}` form.
 *   `location: "global"` is what makes `gemini-4-argon` reachable.
 * - Responses are replayed as their exact native parts, including thought parts
 *   and `thoughtSignature`; that is what keeps tool history stable when
 *   thinking is enabled.
 * - Tool calls that arrived from another provider carry no Gemini signature.
 *   They are projected as text so switching models cannot produce a 400.
 * - An idle timer turns a stream that stops delivering data into a retryable
 *   TIMEOUT instead of a hung session.
 * - Every request carries `attributionHeaders()`, as the LLM seam requires.
 *
 * @module dsh-gemini-argon
 */

import { execFile } from 'node:child_process'
import { createHash, createSign } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  assertUsableApiKey,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
  offloadedImageText,
  projectOffloadedImages,
  resolveImageAttachmentAccess,
} from '@deepseek-ai/dsh-llm'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { isVolatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'

const execFileAsync = promisify(execFile)

/** Route id this plugin owns. Unique across the profile so no other adapter conflicts. */
export const PROVIDER = 'gemini-argon'
/** Default Vertex publisher model id. */
const DEFAULT_MODEL = 'gemini-4-argon'
const DEFAULT_MODEL_NAME = 'Gemini 4 Argon'
const DEFAULT_BASE_URL = 'https://aiplatform.googleapis.com'
const DEFAULT_LOCATION = 'global'
const DEFAULT_API_KEY_ENV = 'GOOGLE_VERTEX_API_KEY'
const DEFAULT_CONTEXT_WINDOW = 1048576
const DEFAULT_MAX_TOKENS = 65536
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_IMAGE_MAX_PIXELS = 2048 * 2048
const DEFAULT_IMAGE_MAX_BYTES = 2 * 1024 * 1024
const THINKING_LEVELS = ['off', 'low', 'medium', 'high']
const AUTH_MODES = ['auto', 'api-key', 'service-account']
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
/** Access tokens are refreshed this long before their reported expiry. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000
/** First three 429 retries stay quick; later ones wait a full cooldown. */
const RATE_LIMIT_QUICK_DELAYS_MS = [2_000, 5_000, 10_000]
const RATE_LIMIT_COOLDOWN_MS = 60_000
/** A 429 streak older than this is treated as a new episode. */
const RATE_LIMIT_STREAK_WINDOW_MS = 2 * 60 * 1000
const RATE_LIMIT_MAX_RETRIES = 5
/** Error bodies are diagnostics, not payloads; keep logs and messages bounded. */
const MAX_ERROR_BODY = 4000

export const Config = z.object({
  /** Credential reference resolved through the credentials service (or the launch environment). */
  apiKeyEnv: z.string().default('').role('credential-ref').volatile(),
  /**
   * `auto` uses a service account when one is configured and the API key
   * otherwise; `api-key` and `service-account` force one method.
   */
  auth: z.union(AUTH_MODES).default('auto').volatile(),
  /** Path to a Google service account JSON key file. `~` is expanded. */
  serviceAccountFile: z.string().default('').volatile(),
  /**
   * Inline service account JSON. Stored in plain text wherever plugin config
   * lives, so prefer `serviceAccountFile` or `GOOGLE_APPLICATION_CREDENTIALS`.
   */
  serviceAccountJson: z.string().default('').volatile(),
  /** Google Cloud project number or id. Required for Express keys to reach non-regional models. */
  project: z.string().default('').volatile(),
  /** Vertex location. `global` is the endpoint family that serves gemini-4-argon. */
  location: z.string().default(DEFAULT_LOCATION).volatile(),
  /** HTTP root override, mainly for tests and private gateways. */
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
  /** Exact publisher model id. */
  model: z.string().default(DEFAULT_MODEL).volatile(),
  /** Display name shown by model selection surfaces. */
  modelName: z.string().default(DEFAULT_MODEL_NAME).volatile(),
  contextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW).volatile(),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS).volatile(),
  /** Fail a request when no stream event arrives for this long. */
  streamIdleTimeoutMs: z.number().step(1).min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS).volatile(),
  /** Largest request image, in pixels, before the attachment layer downsizes it. */
  imageMaxPixels: z.number().step(1).min(1).default(DEFAULT_IMAGE_MAX_PIXELS).volatile(),
  /** Encoded-byte target for one request image. */
  imageMaxBytes: z.number().step(1).min(1).default(DEFAULT_IMAGE_MAX_BYTES).volatile(),
  /**
   * Default reasoning level. `off` pins the lowest level Gemini 4 Argon
   * supports (LOW) and hides thought summaries; the model has no true off.
   */
  thinkingLevel: z.union(THINKING_LEVELS).default('off').volatile(),
  /**
   * Outbound route: `auto` (environment, then the macOS system proxy),
   * `direct`, or an explicit `http(s)://` proxy URL. Google endpoints are not
   * reachable directly from mainland networks, and Node's fetch does not read
   * the macOS system proxy the way curl does.
   */
  proxy: z.string().default('auto').volatile(),
})

/** Read a possibly-volatile config tree into plain values. */
function plainOptions(config) {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]),
  )
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`llm-gemini-argon: ${label} must be a positive integer`)
  }
  return value
}

function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Validate a service account document, whether parsed from a file or inline.
 * Only the fields needed for the JWT bearer flow are read; the private key
 * never leaves this object and never appears in an error message.
 * @param {string|object} input - JSON text or an already-parsed document.
 * @param {string} source - where the document came from, for diagnostics.
 * @returns {object} detached service account facts.
 */
export function parseServiceAccount(input, source) {
  let value = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch {
      throw new Error(`llm-gemini-argon: ${source} is not valid JSON`)
    }
  }
  if (!isObject(value)) throw new Error(`llm-gemini-argon: ${source} must be a JSON object`)
  if (value.type !== undefined && value.type !== 'service_account') {
    throw new Error(`llm-gemini-argon: ${source} has type ${JSON.stringify(value.type)}, not "service_account"`)
  }
  const clientEmail = typeof value.client_email === 'string' ? value.client_email.trim() : ''
  if (!clientEmail.includes('@')) {
    throw new Error(`llm-gemini-argon: ${source} has no usable client_email`)
  }
  const privateKey = typeof value.private_key === 'string' ? value.private_key : ''
  if (!/-----BEGIN (?:RSA )?PRIVATE KEY-----/u.test(privateKey)) {
    throw new Error(`llm-gemini-argon: ${source} has no usable private_key`)
  }
  const projectId = typeof value.project_id === 'string' ? value.project_id.trim() : ''
  const tokenUri = typeof value.token_uri === 'string' && value.token_uri.trim().length > 0
    ? value.token_uri.trim()
    : DEFAULT_TOKEN_URI
  let parsedTokenUri
  try {
    parsedTokenUri = new URL(tokenUri)
  } catch {
    throw new Error(`llm-gemini-argon: ${source} has an invalid token_uri`)
  }
  if (!['http:', 'https:'].includes(parsedTokenUri.protocol)) {
    throw new Error(`llm-gemini-argon: ${source} token_uri must be HTTP(S)`)
  }
  return {
    clientEmail,
    privateKey,
    projectId,
    tokenUri,
    privateKeyId: typeof value.private_key_id === 'string' ? value.private_key_id : undefined,
    source,
  }
}

let serviceAccountFileCache

/** Read and validate one key file, reusing the parsed value until the file changes. */
function loadServiceAccountFile(path) {
  let stat
  try {
    stat = statSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`llm-gemini-argon: service account file not found: ${path}`)
    throw error
  }
  const cached = serviceAccountFileCache
  if (cached !== undefined && cached.path === path && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.value
  }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`llm-gemini-argon: service account file not found: ${path}`)
    throw error
  }
  const value = parseServiceAccount(text, path)
  serviceAccountFileCache = { path, mtimeMs: stat.mtimeMs, size: stat.size, value }
  return value
}

let serviceAccountAsyncCache
let serviceAccountAsyncInflight

/**
 * Read a key file without blocking the boot path. Cloud-synced folders can make
 * a synchronous read hang (or throw ETIMEDOUT), so file-backed service accounts
 * are allowed to materialize at request time.
 */
async function loadServiceAccountFileAsync(path) {
  let stat
  try {
    stat = statSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new LlmError(`llm-gemini-argon: service account file not found: ${path}`, 'INVALID_CREDENTIAL', { cause: error })
    throw new LlmError(`llm-gemini-argon: cannot stat service account file "${path}": ${error?.message ?? error}`, 'INVALID_CREDENTIAL', { cause: error })
  }
  const cached = serviceAccountAsyncCache
  if (cached !== undefined && cached.path === path && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.value
  }
  if (serviceAccountAsyncInflight?.path === path) return serviceAccountAsyncInflight.promise
  const promise = (async () => {
    let text
    try {
      text = await readFile(path, { encoding: 'utf8', signal: AbortSignal.timeout(15_000) })
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? 'read timed out' : (error?.message ?? String(error))
      throw new LlmError(
        `llm-gemini-argon: cannot read service account file "${path}" (${reason}). If it lives in a cloud-synced folder, move it to a local path (for example ~/.config/gcloud/) or make it available offline.`,
        'INVALID_CREDENTIAL',
        { cause: error },
      )
    }
    const value = parseServiceAccount(text, path)
    serviceAccountAsyncCache = { path, mtimeMs: stat.mtimeMs, size: stat.size, value }
    return value
  })().finally(() => {
    if (serviceAccountAsyncInflight?.path === path) serviceAccountAsyncInflight = undefined
  })
  serviceAccountAsyncInflight = { path, promise }
  return promise
}

/** Resolve a deferred file descriptor into a parsed service account. */
async function materializeServiceAccount(serviceAccount) {
  if (serviceAccount === undefined) return undefined
  if (typeof serviceAccount.privateKey === 'string') return serviceAccount
  if (serviceAccount.kind === 'file') return loadServiceAccountFileAsync(serviceAccount.path)
  throw new LlmError('llm-gemini-argon: invalid service account configuration', 'INVALID_CREDENTIAL')
}

/** Resolve the configured service account, if any. */
function loadServiceAccount(raw) {
  if (isObject(raw.serviceAccountJson)) return parseServiceAccount(raw.serviceAccountJson, 'serviceAccountJson')
  const inline = String(raw.serviceAccountJson ?? '').trim()
  if (inline.length > 0) return parseServiceAccount(inline, 'serviceAccountJson')
  const file = String(raw.serviceAccountFile ?? '').trim() || String(process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim()
  if (file.length === 0) return undefined
  const path = expandHome(file)
  try {
    return loadServiceAccountFile(path)
  } catch (error) {
    // A cloud-synced key may be unreadable at boot; keep the route mountable and
    // retry with the async reader on the first request.
    return { kind: 'file', path, deferredError: error }
  }
}

function base64url(value) {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/** Build the RS256-signed JWT assertion for the OAuth2 JWT bearer grant. */
export function serviceAccountJwt(serviceAccount, now = Math.floor(Date.now() / 1000)) {
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    ...(serviceAccount.privateKeyId === undefined ? {} : { kid: serviceAccount.privateKeyId }),
  }
  const claims = {
    iss: serviceAccount.clientEmail,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: serviceAccount.tokenUri,
    iat: now,
    exp: now + 3600,
  }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  let signature
  try {
    signature = createSign('RSA-SHA256').update(signingInput).sign(serviceAccount.privateKey)
  } catch (error) {
    throw new LlmError('llm-gemini-argon: service account private key cannot sign a JWT', 'INVALID_CREDENTIAL', { cause: error })
  }
  return `${signingInput}.${signature.toString('base64url')}`
}

const tokenCache = new Map()

/** Consecutive 429 counts per session, so retries follow a predictable cadence. */
const rateLimitStreaks = new Map()

function nextRateLimitDelay(key) {
  const now = Date.now()
  const previous = rateLimitStreaks.get(key)
  const count = previous !== undefined && now - previous.at < RATE_LIMIT_STREAK_WINDOW_MS ? previous.count + 1 : 1
  rateLimitStreaks.set(key, { count, at: now })
  if (count <= RATE_LIMIT_QUICK_DELAYS_MS.length) return RATE_LIMIT_QUICK_DELAYS_MS[count - 1]
  return RATE_LIMIT_COOLDOWN_MS
}

function clearRateLimitStreak(key) {
  rateLimitStreaks.delete(key)
}

function tokenCacheKey(serviceAccount) {
  const digest = createHash('sha256').update(serviceAccount.privateKey).digest('hex')
  return `${serviceAccount.clientEmail}\u0000${digest}`
}

/** Exchange the JWT assertion for an OAuth2 access token. */
async function requestServiceAccountToken(serviceAccount, config) {
  const assertion = serviceAccountJwt(serviceAccount)
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }).toString()
  let response
  try {
    const proxy = await proxyFor(config, serviceAccount.tokenUri, process.env)
    response = await fetchRequest(serviceAccount.tokenUri, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    }, proxy)
  } catch (error) {
    throw new LlmError('llm-gemini-argon: service account token request failed', 'TRANSPORT', { cause: error })
  }
  const text = bounded(await response.text().catch(() => ''))
  if (!response.ok) {
    let detail = text
    try {
      const parsed = JSON.parse(text)
      if (isObject(parsed)) {
        if (typeof parsed.error_description === 'string') detail = parsed.error_description
        else if (typeof parsed.error === 'string') detail = parsed.error
      }
    } catch {}
    const code = response.status === 400 || response.status === 401 || response.status === 403
      ? 'INVALID_CREDENTIAL'
      : response.status === 429
        ? 'RATE_LIMIT'
        : response.status >= 500
          ? 'SERVER'
          : `HTTP_${response.status}`
    throw new LlmError(
      `llm-gemini-argon: service account token request failed (${response.status}): ${bounded(detail)}`,
      code,
      { status: response.status, cause: new Error(text) },
    )
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new LlmError('llm-gemini-argon: service account token endpoint returned invalid JSON', 'MALFORMED_RESPONSE')
  }
  if (!isObject(parsed) || typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
    throw new LlmError('llm-gemini-argon: service account token endpoint returned no access_token', 'MALFORMED_RESPONSE')
  }
  const expiresIn = typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in) && parsed.expires_in > 0
    ? parsed.expires_in
    : 3600
  return { accessToken: parsed.access_token, expiresAt: Date.now() + expiresIn * 1000 }
}

/** Cached access token for one service account, refreshed shortly before expiry. */
async function accessTokenFor(serviceAccount, config, force = false) {
  const key = tokenCacheKey(serviceAccount)
  const now = Date.now()
  if (!force) {
    const hit = tokenCache.get(key)
    if (hit !== undefined) {
      if (hit.pending !== undefined) return hit.pending
      if (hit.accessToken !== undefined && hit.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) return hit.accessToken
    }
  }
  const pending = requestServiceAccountToken(serviceAccount, config).then(({ accessToken, expiresAt }) => {
    tokenCache.set(key, { accessToken, expiresAt })
    return accessToken
  }, (error) => {
    tokenCache.delete(key)
    throw error
  })
  tokenCache.set(key, { pending })
  return pending
}

/** Drop the cached token for one service account, e.g. after a 401. */
export function invalidateServiceAccountToken(serviceAccount) {
  tokenCache.delete(tokenCacheKey(serviceAccount))
}

/**
 * Resolve the request headers for the configured authentication mode.
 * @param {object} config - validated settings.
 * @param {boolean} force - refresh a cached service account token first.
 * @returns {Promise<object>} `{ kind, headers, invalidate? }`.
 */
export async function serviceAccountAuth(config, force = false) {
  const serviceAccount = await materializeServiceAccount(config.serviceAccount)
  if (serviceAccount === undefined) {
    throw new LlmError('llm-gemini-argon: service-account auth has no service account configured', 'INVALID_CREDENTIAL')
  }
  const token = await accessTokenFor(serviceAccount, config, force)
  return {
    kind: 'service-account',
    headers: { authorization: `Bearer ${token}` },
    invalidate: () => invalidateServiceAccountToken(serviceAccount),
  }
}

/**
 * Validate raw plugin config into detached request settings.
 * @param {object} raw - plain config values.
 * @returns {object} validated settings.
 */
export function resolveOptions(raw) {
  const baseURL = String(raw.baseURL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/u, '')
  let parsed
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new Error(`llm-gemini-argon: baseURL ${JSON.stringify(baseURL)} is not a URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('llm-gemini-argon: baseURL must be an HTTP(S) root without credentials, query, or fragment')
  }

  const authMode = String(raw.auth ?? 'auto').trim() || 'auto'
  if (!AUTH_MODES.includes(authMode)) {
    throw new Error(`llm-gemini-argon: auth must be one of ${AUTH_MODES.join(', ')}`)
  }
  const serviceAccount = loadServiceAccount(raw)
  const useServiceAccount = authMode === 'service-account' || (authMode === 'auto' && serviceAccount !== undefined)
  if (authMode === 'service-account' && serviceAccount === undefined) {
    throw new Error('llm-gemini-argon: auth "service-account" requires serviceAccountFile, serviceAccountJson, or GOOGLE_APPLICATION_CREDENTIALS')
  }

  const project = String(raw.project ?? '').trim()
    || (useServiceAccount ? String(serviceAccount?.projectId ?? '').trim() : '')
    || String(process.env.GOOGLE_CLOUD_PROJECT ?? '').trim()
  if (project.length === 0) {
    throw new Error(
      useServiceAccount
        ? 'llm-gemini-argon: project is required; set the Cloud Console project ID/number, add project_id to the service account JSON, or export GOOGLE_CLOUD_PROJECT'
        : 'llm-gemini-argon: project is required; set the Cloud Console project ID/number (Project info card) or export GOOGLE_CLOUD_PROJECT — Express API keys do not carry a project',
    )
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(project)) {
    throw new Error(`llm-gemini-argon: project ${JSON.stringify(project)} is not a project id or number`)
  }

  const location = String(raw.location ?? DEFAULT_LOCATION).trim()
  if (location.length === 0 || location.includes('/') || location.includes(':')) {
    throw new Error(`llm-gemini-argon: location ${JSON.stringify(location)} is not a Vertex location`)
  }

  const model = String(raw.model ?? DEFAULT_MODEL).trim()
  if (model.length === 0) throw new Error('llm-gemini-argon: model must not be empty')

  const modelName = String(raw.modelName ?? DEFAULT_MODEL_NAME).trim() || model
  const thinkingLevel = String(raw.thinkingLevel ?? 'off')
  if (!THINKING_LEVELS.includes(thinkingLevel)) {
    throw new Error(`llm-gemini-argon: thinkingLevel must be one of ${THINKING_LEVELS.join(', ')}`)
  }
  const apiKeyEnv = String(raw.apiKeyEnv ?? '').trim() || DEFAULT_API_KEY_ENV

  const proxy = String(raw.proxy ?? 'auto').trim()
  if (proxy !== '' && proxy !== 'auto' && proxy !== 'direct') {
    let parsedProxy
    try {
      parsedProxy = new URL(proxy)
    } catch {
      throw new Error(`llm-gemini-argon: proxy ${JSON.stringify(proxy)} is not a URL, "auto", or "direct"`)
    }
    if (!['http:', 'https:'].includes(parsedProxy.protocol)) {
      throw new Error('llm-gemini-argon: proxy must be an http:// or https:// URL')
    }
  }

  return {
    apiKeyEnv: credentialRef(apiKeyEnv),
    auth: useServiceAccount ? 'service-account' : 'api-key',
    serviceAccount: useServiceAccount ? serviceAccount : undefined,
    baseURL,
    project,
    location,
    model,
    modelName,
    contextWindow: positiveInteger(raw.contextWindow ?? DEFAULT_CONTEXT_WINDOW, 'contextWindow'),
    maxTokens: positiveInteger(raw.maxTokens ?? DEFAULT_MAX_TOKENS, 'maxTokens'),
    streamIdleTimeoutMs: positiveInteger(raw.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS, 'streamIdleTimeoutMs'),
    imageMaxPixels: positiveInteger(raw.imageMaxPixels ?? DEFAULT_IMAGE_MAX_PIXELS, 'imageMaxPixels'),
    imageMaxBytes: positiveInteger(raw.imageMaxBytes ?? DEFAULT_IMAGE_MAX_BYTES, 'imageMaxBytes'),
    thinkingLevel,
    proxy,
  }
}

/** Read the macOS system proxy through `scutil`; Node's fetch never consults it. */
let systemProxyCache
async function systemProxy() {
  if (process.platform !== 'darwin') return undefined
  const now = Date.now()
  if (systemProxyCache !== undefined && now - systemProxyCache.at < 60_000) return systemProxyCache.value
  let value
  try {
    const { stdout } = await execFileAsync('scutil', ['--proxy'], { timeout: 3000 })
    const field = (name) => {
      const match = new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)\\s*$`, 'mu').exec(stdout)
      return match?.[1]
    }
    for (const scheme of ['HTTPS', 'HTTP']) {
      if (field(`${scheme}Enable`) !== '1') continue
      const host = field(`${scheme}Proxy`)
      const port = field(`${scheme}Port`)
      if (host !== undefined && port !== undefined) {
        value = `http://${host}:${port}`
        break
      }
    }
  } catch {}
  systemProxyCache = { at: now, value }
  return value
}

function bypassesProxy(env, hostname) {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true
  const list = env.no_proxy ?? env.NO_PROXY
  if (list === undefined || list.length === 0) return false
  return list.split(',').map((entry) => entry.trim().replace(/^\./u, '')).filter(Boolean).some((entry) => {
    if (entry === '*') return true
    const host = entry.replace(/:\d+$/u, '')
    return hostname === host || hostname.endsWith(`.${host}`)
  })
}

/**
 * Resolve the proxy one request should use.
 * @param {object} config - validated settings (`proxy` is "auto", "direct", or a URL).
 * @param {string} url - request URL.
 * @param {object} env - launch environment map.
 * @returns {Promise<string|undefined>} proxy URL, or undefined for a direct connection.
 */
export async function proxyFor(config, url, env = process.env) {
  if (bypassesProxy(env, new URL(url).hostname)) return undefined
  if (config.proxy === 'direct') return undefined
  if (config.proxy !== 'auto' && config.proxy !== '') return config.proxy
  const fromEnv = env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return systemProxy()
}

const dispatchers = new Map()

/**
 * Fetch through undici's ProxyAgent when a proxy is resolved, or through the
 * process-wide fetch (which already carries the harness proxy dispatcher).
 */
async function fetchRequest(url, init, proxy) {
  if (proxy === undefined) return fetch(url, init)
  const undici = await import('undici')
  let dispatcher = dispatchers.get(proxy)
  if (dispatcher === undefined) {
    dispatcher = new undici.ProxyAgent(proxy)
    dispatchers.set(proxy, dispatcher)
  }
  return undici.fetch(url, { ...init, dispatcher })
}

/** Build the `streamGenerateContent` endpoint for one model id. */
export function endpointOf(options, model) {
  const path = model.split('/').map(encodeURIComponent).join('/')
  const suffix = `/publishers/google/models/${path}:streamGenerateContent?alt=sse`
  if (options.project.length === 0) return `${options.baseURL}/v1${suffix}`
  return `${options.baseURL}/v1/projects/${encodeURIComponent(options.project)}/locations/${encodeURIComponent(options.location)}${suffix}`
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseArguments(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (isObject(parsed)) return parsed
  } catch {}
  return {}
}

function textOf(content) {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** Validate one durable replay envelope produced by this adapter. */
function readReplay(state) {
  if (!isObject(state) || state.kind !== 'gemini-argon' || state.version !== 1) return undefined
  const blocks = Array.isArray(state.blocks) ? state.blocks : undefined
  const parts = Array.isArray(state.parts) ? state.parts : undefined
  if (blocks === undefined) return undefined
  return { blocks, parts }
}

/** Copy the fields this adapter replays; everything else in a native part is dropped. */
function replayPart(part) {
  if (!isObject(part)) return undefined
  const out = {}
  if (typeof part.text === 'string') out.text = part.text
  if (part.thought === true) out.thought = true
  if (typeof part.thoughtSignature === 'string') out.thoughtSignature = part.thoughtSignature
  if (isObject(part.functionCall) && typeof part.functionCall.name === 'string') {
    out.functionCall = {
      name: part.functionCall.name,
      args: isObject(part.functionCall.args) ? part.functionCall.args : {},
      ...(typeof part.functionCall.id === 'string' ? { id: part.functionCall.id } : {}),
    }
  }
  if (!('text' in out) && !('functionCall' in out)) return undefined
  return out
}

/** The attachment-layer projection this route asks for one request image. */
function imageTargetOf(image, config) {
  return {
    ...requestImageDimensions(image.width, image.height, config.imageMaxPixels),
    maxBytes: config.imageMaxBytes,
  }
}

/**
 * Resolve request image bytes and replace offloaded images with text handles.
 * @param {Array} messages - provider-neutral history.
 * @param {object} config - validated settings.
 * @param {object} attachments - mounted attachment service, when present.
 * @param {Function} imageAccess - resolves the execution-world path of one image.
 * @param {AbortSignal} signal - request cancellation.
 * @returns {Promise<{messages: Array, versions: Map}>} projected history and bytes.
 */
export async function prepareRequestImages(messages, config, attachments, imageAccess, signal) {
  const projected = projectOffloadedImages(messages, (ref) => offloadedImageText(ref, imageAccess?.(ref)))
  if (!projected.some((message) => contentHasImage(message.content))) {
    return { messages: projected, versions: new Map() }
  }
  if (attachments === undefined) {
    throw new LlmError('llm-gemini-argon: image input requires the mounted attachment service', 'UNSUPPORTED_CONTENT')
  }
  const refs = new Map()
  for (const message of projected) {
    if (!contentHasImage(message.content)) continue
    if (message.role !== 'user' && message.role !== 'tool') {
      throw new LlmError('llm-gemini-argon: images are supported only in user messages and tool results', 'UNSUPPORTED_CONTENT')
    }
    for (const block of message.content) {
      if (block.type === 'image' && !refs.has(block.attachment.attachmentId)) {
        refs.set(block.attachment.attachmentId, block.attachment)
      }
    }
  }
  const versions = new Map()
  for (const [id, ref] of refs) {
    versions.set(id, await attachments.readImageRequest(ref, imageTargetOf(ref, config), signal))
  }
  return { messages: projected, versions }
}

/** Build one Gemini `inlineData` part from a prepared request image. */
function imagePart(block, images) {
  const version = images.get(block.attachment.attachmentId)
  if (version === undefined) {
    throw new LlmError('llm-gemini-argon: request image is missing from the prepared set', 'INVALID_REQUEST')
  }
  return {
    inlineData: {
      mimeType: version.mediaType,
      data: Buffer.from(version.data).toString('base64'),
    },
  }
}

/**
 * Convert provider-neutral messages into one Gemini `GenerateContent` body.
 * Exported for tests; the adapter is the only production caller.
 */
export function buildRequestBody(options, config, images = new Map()) {
  const systemTexts = []
  const contents = []
  const callNames = new Map()
  /** Tool calls that arrived without a Gemini signature and were projected as text. */
  const degradedCalls = new Set()
  const thinkingLevel = String(options.reasoningEffort ?? config.thinkingLevel)
  if (typeof options.system === 'string' && options.system.length > 0) systemTexts.push(options.system)

  // Vertex rejects a functionResponse turn that also carries text or inline
  // data ("Requests ending with a model turn are not supported"), so a turn's
  // kind decides whether the next same-role content may merge into it.
  let lastRole
  let lastKind
  const push = (role, parts, kind = 'normal') => {
    if (parts.length === 0) return
    const mergeable = lastRole === role && (kind === 'function-response' ? lastKind === 'function-response' : lastKind !== 'function-response')
    if (mergeable) contents.at(-1).parts.push(...parts)
    else contents.push({ role, parts })
    lastRole = role
    lastKind = kind
  }

  // Images carried by tool results cannot live in the functionResponse turn
  // itself; they are collected and appended as the next plain user turn.
  const toolImages = []
  const flushToolImages = () => {
    if (toolImages.length === 0) return
    push('user', toolImages.splice(0))
  }

  for (const message of options.messages ?? []) {
    if (message.role !== 'tool') flushToolImages()
    if (message.role === 'developer' || message.role === 'system') {
      const text = textOf(message.content)
      if (text.length > 0) systemTexts.push(text)
      continue
    }

    if (message.role === 'user') {
      const parts = []
      for (const block of message.content) {
        if (block.type === 'text' && block.text.length > 0) parts.push({ text: block.text })
        else if (block.type === 'image') parts.push(imagePart(block, images))
      }
      push('user', parts)
      continue
    }

    if (message.role === 'assistant') {
      const replay = readReplay(message.source?.replayState)
      if (replay?.parts !== undefined && replay.parts.length > 0 && replay.blocks?.length === message.content.length) {
        const parts = replay.parts.map(replayPart).filter((part) => part !== undefined)
        if (parts.length > 0) {
          for (const block of message.content) {
            if (block.type === 'tool-call') callNames.set(block.id, block.name)
          }
          push('model', parts)
          continue
        }
      }
      const parts = []
      for (const [index, block] of message.content.entries()) {
        const signature = replay?.blocks?.[index]?.signature
        if (block.type === 'text') {
          if (block.text.length > 0) {
            parts.push({ text: block.text, ...(typeof signature === 'string' ? { thoughtSignature: signature } : {}) })
          }
        } else if (block.type === 'tool-call' && typeof block.name === 'string' && block.name.length > 0) {
          callNames.set(block.id, block.name)
          if (typeof signature === 'string') {
            parts.push({
              functionCall: { name: block.name, args: parseArguments(block.arguments) },
              thoughtSignature: signature,
            })
          } else {
            // A call produced by another provider has no Gemini signature. Vertex
            // rejects such a functionCall part outright, so project the exchange
            // as text and keep the conversation usable across model switches.
            degradedCalls.add(block.id)
            parts.push({ text: `[Tool call ${block.name}(${block.arguments || '{}'}) from an earlier model turn]` })
          }
        }
      }
      push('model', parts)
      continue
    }

    if (message.role === 'tool') {
      const name = callNames.get(message.toolCallId) ?? 'tool'
      const text = textOf(message.content)
      const degraded = message.toolCallId === undefined || degradedCalls.has(message.toolCallId) || !callNames.has(message.toolCallId)
      const imageParts = []
      for (const block of message.content) if (block.type === 'image') imageParts.push(imagePart(block, images))
      if (degraded) {
        flushToolImages()
        push('user', [{
          text: `[${message.isError === true ? 'Tool error' : 'Tool result'} from ${name}: ${text || '(no output)'}]`,
        }, ...imageParts])
        continue
      }
      const response = message.isError === true ? { error: text || 'tool failed' } : { result: text }
      push('user', [{ functionResponse: { name, response } }], 'function-response')
      toolImages.push(...imageParts)
      continue
    }
  }

  flushToolImages()

  if (contents.length === 0) {
    throw new LlmError('llm-gemini-argon: request has no conversation messages', 'INVALID_REQUEST')
  }

  const declarations = (options.tools ?? []).map((tool) => ({
    name: tool.name,
    ...(typeof tool.description === 'string' && tool.description.length > 0 ? { description: tool.description } : {}),
    parameters: isObject(tool.parameters) ? tool.parameters : { type: 'object', properties: {} },
  }))

  const maxOutputTokens = options.maxTokens ?? config.maxTokens

  return {
    contents,
    ...(systemTexts.length > 0 ? { systemInstruction: { parts: systemTexts.map((text) => ({ text })) } } : {}),
    ...(declarations.length > 0 ? { tools: [{ functionDeclarations: declarations }] } : {}),
    generationConfig: {
      ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
      ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
      ...(Array.isArray(options.stop) && options.stop.length > 0 ? { stopSequences: [...options.stop] } : {}),
      // Gemini 4 Argon cannot disable thinking (thinkingBudget is rejected and
      // "OFF" is not a valid level). "off" therefore pins the minimum level the
      // model supports and omits thought summaries; only explicit low/medium/high
      // ask Vertex to return the thinking text.
      thinkingConfig: {
        thinkingLevel: (thinkingLevel === 'off' ? 'low' : thinkingLevel).toUpperCase(),
        ...(thinkingLevel === 'off' ? {} : { includeThoughts: true }),
      },
    },
  }
}

/** Decode `text/event-stream` frames from a fetch body. */
async function* parseSse(body, onActivity) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events = []
  const drain = (flush) => {
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      events.push(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
    }
    if (flush && buffer.length > 0) {
      events.push(buffer)
      buffer = ''
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      onActivity?.()
      buffer += decoder.decode(value, { stream: true })
      drain(false)
      while (events.length > 0) {
        const line = events.shift().replace(/\r$/u, '')
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data.length === 0 || data === '[DONE]') continue
        try {
          yield JSON.parse(data)
        } catch {
          throw new LlmError('llm-gemini-argon: SSE frame is not valid JSON', 'MALFORMED_RESPONSE')
        }
      }
    }
    buffer += decoder.decode()
    drain(true)
    for (const raw of events) {
      const line = raw.replace(/\r$/u, '')
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data.length === 0 || data === '[DONE]') continue
      try {
        yield JSON.parse(data)
      } catch {
        throw new LlmError('llm-gemini-argon: SSE frame is not valid JSON', 'MALFORMED_RESPONSE')
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {}
  }
}

function usageOf(raw) {
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const inputTokens = number(raw.promptTokenCount)
  const outputTokens = number(raw.candidatesTokenCount) + number(raw.thoughtsTokenCount)
  const totalTokens = number(raw.totalTokenCount) || inputTokens + outputTokens
  const cacheReadTokens = number(raw.cachedContentTokenCount)
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
  }
}

/** Classify a Vertex error into the harness's stable failure codes. */
function failureOf(status, detail) {
  let code
  if (status === 401 || status === 403) code = 'AUTH'
  else if (isQuotaExceededError(detail)) code = 'QUOTA'
  else if (status === 429) code = 'RATE_LIMIT'
  else if (isContextWindowExceededError(detail)) code = 'CONTEXT_WINDOW_EXCEEDED'
  else if (status === 400 || status === 413) code = 'INVALID_REQUEST'
  else if (status !== undefined && status >= 500) code = 'SERVER'
  else code = status === undefined ? 'SERVER' : `HTTP_${status}`
  return code
}

function bounded(value) {
  const text = typeof value === 'string' ? value : String(value)
  return text.length <= MAX_ERROR_BODY ? text : `${text.slice(0, MAX_ERROR_BODY)}…`
}

/** Build one LlmError from an HTTP response body. */
async function httpFailure(response) {
  const text = bounded(await response.text().catch(() => ''))
  let message = text
  try {
    const parsed = JSON.parse(text)
    if (isObject(parsed.error) && typeof parsed.error.message === 'string') message = parsed.error.message
  } catch {}
  const detail = `${statusTextOf(response)} ${message}`
  const retryAfter = response.headers.get('retry-after')
  const delay = retryAfter === null ? NaN : /^\d+(?:\.\d+)?$/u.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()
  return new LlmError(`llm-gemini-argon: Vertex AI request failed (${response.status}): ${bounded(message)}`, failureOf(response.status, detail), {
    status: response.status,
    ...(Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {}),
    cause: new Error(text),
  })
}

function statusTextOf(response) {
  return response.statusText || ''
}

/** The countTokens endpoint: a real, billable-nothing round trip for connectivity tests. */
function countTokensUrl(config, model) {
  const path = model.split('/').map(encodeURIComponent).join('/')
  return `${config.baseURL}/v1/projects/${encodeURIComponent(config.project)}/locations/${encodeURIComponent(config.location)}/publishers/google/models/${path}:countTokens`
}

/** Verify auth, endpoint, and model reachability without generating output tokens. */
export async function probeModel(config, auth, signal) {
  const url = countTokensUrl(config, config.model)
  const timeout = AbortSignal.timeout(20_000)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  let response
  try {
    const proxy = await proxyFor(config, url, process.env)
    response = await fetchRequest(url, {
      method: 'POST',
      signal: combined,
      redirect: 'error',
      headers: {
        ...attributionHeaders(),
        'content-type': 'application/json',
        accept: 'application/json',
        ...auth.headers,
      },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }] }),
    }, proxy)
  } catch (error) {
    if (timeout.aborted) throw new LlmError('llm-gemini-argon: connection test timed out', 'TIMEOUT', { cause: error })
    if (signal?.aborted) throw new LlmError('llm-gemini-argon: connection test aborted', 'ABORTED', { cause: error })
    throw new LlmError('llm-gemini-argon: connection test transport failed', 'TRANSPORT', { cause: error })
  }
  if (!response.ok) throw await httpFailure(response)
  const body = await response.json().catch(() => undefined)
  if (!isObject(body) || typeof body.totalTokens !== 'number') {
    throw new LlmError('llm-gemini-argon: connection test returned an unexpected body', 'MALFORMED_RESPONSE')
  }
  return body.totalTokens
}

/** One route's Vertex AI streaming adapter. */
export class GeminiArgonAdapter extends LlmAdapter {
  constructor({ options, resolveAuth, resolveAttachments, imageAccess }) {
    super()
    this.options = options
    this.resolveAuth = resolveAuth
    this.resolveAttachments = resolveAttachments
    this.imageAccess = imageAccess
  }

  providerInfo(provider) {
    return { id: provider, name: 'Google Vertex AI' }
  }

  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: RATE_LIMIT_MAX_RETRIES,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 1_000,
      maxDelayMs: RATE_LIMIT_COOLDOWN_MS,
      jitterRatio: 0.1,
    }
  }

  async listModels(provider) {
    const config = this.options()
    return [{
      provider,
      id: config.model,
      name: config.modelName,
      description: 'Gemini 4 Argon on Google Vertex AI',
      inputModalities: ['text', 'image'],
    }]
  }

  async resolveModel(provider, model) {
    const config = this.options()
    if (model !== config.model) {
      throw new LlmError(`llm-gemini-argon: unknown model "${model}"; this route serves "${config.model}"`, 'UNKNOWN_MODEL')
    }
    return {
      provider,
      id: model,
      name: config.modelName,
      context: { contextWindow: config.contextWindow },
      defaultMaxTokens: config.maxTokens,
      inputModalities: ['text', 'image'],
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
        ],
        defaultEffort: config.thinkingLevel,
      },
    }
  }

  /** Keep the runtime's image projection identical to the bytes this adapter sends. */
  imageRequestTarget(_provider, _model, image) {
    return imageTargetOf(image, this.options())
  }

  /**
   * Stream one model call as harness chunks.
   * @param {object} options - provider-neutral request.
   */
  async *stream(options) {
    const config = this.options()
    const { messages, versions } = await prepareRequestImages(
      options.messages,
      config,
      this.resolveAttachments?.(),
      this.imageAccess,
      options.signal,
    )
    const body = buildRequestBody({ ...options, messages }, config, versions)
    const url = endpointOf(config, options.model)

    // Reset on every streamed chunk: a provider that accepts the request but
    // never answers must fail as TIMEOUT (which the retry policy can repeat)
    // instead of hanging the session forever.
    const idle = new AbortController()
    let timer
    const pulse = () => {
      clearTimeout(timer)
      timer = setTimeout(() => idle.abort(new Error('idle timeout')), config.streamIdleTimeoutMs)
    }
    pulse()
    const signal = options.signal === undefined ? idle.signal : AbortSignal.any([options.signal, idle.signal])

    const send = async (auth) => {
      const proxy = await proxyFor(config, url, process.env)
      return fetchRequest(url, {
        method: 'POST',
        signal,
        redirect: 'error',
        headers: {
          ...attributionHeaders(),
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...auth.headers,
        },
        body: JSON.stringify(body),
      }, proxy)
    }

    try {
      let auth
      let response
      try {
        auth = await this.resolveAuth()
        response = await send(auth)
        // A cached service account token can expire early (clock skew, revocation);
        // refresh once and retry before surfacing the 401.
        if (response.status === 401 && auth.invalidate !== undefined) {
          await response.body?.cancel().catch(() => {})
          auth.invalidate()
          auth = await this.resolveAuth(true)
          response = await send(auth)
        }
      } catch (error) {
        if (idle.signal.aborted) {
          throw new LlmError(`llm-gemini-argon: Vertex AI stream idle timeout after ${config.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
        }
        if (error instanceof LlmError) throw error
        if (options.signal?.aborted) throw new LlmError('llm-gemini-argon: request aborted', 'ABORTED', { cause: error })
        throw new LlmError('llm-gemini-argon: Vertex AI transport failed', 'TRANSPORT', { cause: error })
      }

      if (!response.ok) {
        const failure = await httpFailure(response)
        if (failure.code === 'RATE_LIMIT') {
          const delay = nextRateLimitDelay(String(options.sessionId ?? 'anonymous'))
          throw new LlmError(failure.message, failure.code, {
            ...(failure.failure?.status === undefined ? {} : { status: failure.failure.status }),
            providerRetryAfterMs: delay,
            cause: failure,
          })
        }
        throw failure
      }
      clearRateLimitStreak(String(options.sessionId ?? 'anonymous'))
      if (response.body === null) throw new LlmError('llm-gemini-argon: Vertex AI returned no response body', EMPTY_RESPONSE_CODE)

      try {
        yield* translate(parseSse(response.body, pulse), options, config)
      } catch (error) {
        if (idle.signal.aborted) {
          throw new LlmError(`llm-gemini-argon: Vertex AI stream idle timeout after ${config.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
        }
        if (options.signal?.aborted) throw new LlmError('llm-gemini-argon: request aborted', 'ABORTED', { cause: error })
        if (error instanceof LlmError) throw error
        throw new LlmError('llm-gemini-argon: Vertex AI stream failed', 'TRANSPORT', { cause: error })
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Translate Vertex SSE responses into the harness chunk protocol. */
async function* translate(events, options, config) {
  const blocks = []
  const rawParts = []
  let textBlock
  let reasoningBlock
  let finishReason
  let usage
  let sawEvent = false

  const close = (block) => ({ type: 'block-end', index: block.index, block: block.type === 'text' ? { type: 'text', text: block.text } : { type: 'reasoning', text: block.text } })

  for await (const event of events) {
    sawEvent = true
    if (isObject(event.error)) {
      const detail = typeof event.error.message === 'string' ? event.error.message : JSON.stringify(event.error)
      throw new LlmError(`llm-gemini-argon: Vertex AI stream error: ${bounded(detail)}`, failureOf(event.error.code, detail))
    }
    const candidate = Array.isArray(event.candidates) ? event.candidates[0] : undefined
    if (isObject(candidate) && typeof candidate.finishReason === 'string') finishReason = candidate.finishReason
    if (isObject(event.usageMetadata)) usage = usageOf(event.usageMetadata)

    const parts = isObject(candidate) && isObject(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : []
    for (const part of parts) {
      if (!isObject(part)) continue
      const copy = replayPart(part)
      if (copy !== undefined) rawParts.push(copy)

      if (part.thought === true && typeof part.text === 'string' && part.text.length > 0) {
        if (textBlock !== undefined) {
          yield close(textBlock)
          textBlock = undefined
        }
        if (reasoningBlock === undefined) {
          reasoningBlock = { index: blocks.length, type: 'reasoning', text: '', signature: undefined }
          blocks.push(reasoningBlock)
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += part.text
        if (typeof part.thoughtSignature === 'string') reasoningBlock.signature = part.thoughtSignature
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: part.text }
        continue
      }

      if (typeof part.text === 'string' && part.text.length > 0) {
        if (reasoningBlock !== undefined) {
          yield close(reasoningBlock)
          reasoningBlock = undefined
        }
        if (textBlock === undefined) {
          textBlock = { index: blocks.length, type: 'text', text: '', signature: undefined }
          blocks.push(textBlock)
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += part.text
        if (typeof part.thoughtSignature === 'string') textBlock.signature = part.thoughtSignature
        yield { type: 'text-delta', index: textBlock.index, text: part.text }
        continue
      }

      if (typeof part.thoughtSignature === 'string') {
        const last = blocks.at(-1)
        if (last !== undefined && last.signature === undefined) last.signature = part.thoughtSignature
      }

      if (isObject(part.functionCall) && typeof part.functionCall.name === 'string' && part.functionCall.name.length > 0) {
        if (textBlock !== undefined) {
          yield close(textBlock)
          textBlock = undefined
        }
        if (reasoningBlock !== undefined) {
          yield close(reasoningBlock)
          reasoningBlock = undefined
        }
        const id = typeof part.functionCall.id === 'string' && part.functionCall.id.length > 0
          ? part.functionCall.id
          : `call_${blocks.length}_${Date.now().toString(36)}`
        const name = part.functionCall.name
        const json = JSON.stringify(isObject(part.functionCall.args) ? part.functionCall.args : {})
        const index = blocks.length
        blocks.push({ index, type: 'tool-call', id, name, json, signature: part.thoughtSignature })
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name, argumentsDelta: json }
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: json } }
      }
    }
  }

  if (textBlock !== undefined) yield close(textBlock)
  if (reasoningBlock !== undefined) yield close(reasoningBlock)

  if (!sawEvent) throw new LlmError('llm-gemini-argon: Vertex AI returned an empty event stream', EMPTY_RESPONSE_CODE)
  if (blocks.length === 0) {
    throw new LlmError(
      `llm-gemini-argon: Vertex AI returned no content (finishReason: ${finishReason ?? 'none'})`,
      EMPTY_RESPONSE_CODE,
    )
  }

  const hasToolCalls = blocks.some((block) => block.type === 'tool-call')
  const reason = hasToolCalls
    ? { kind: 'tool-calls' }
    : finishReason === 'MAX_TOKENS'
      ? { kind: 'max-tokens' }
      : { kind: 'stop' }

  if (usage !== undefined) yield { type: 'usage', usage }
  yield {
    type: 'finish',
    reason,
    replayState: {
      kind: 'gemini-argon',
      version: 1,
      // A truncated turn drops tool calls from the durable message; replaying
      // the raw parts would resend them, so fall back to block reconstruction.
      parts: reason.kind === 'max-tokens' ? [] : rawParts,
      blocks: blocks.map((block) => (typeof block.signature === 'string' ? { signature: block.signature } : {})),
    },
  }
}

export const name = 'llm-gemini-argon'
export const inject = ['llm']

/** Mount the route and its adapter into the harness LLM registry. */
export function apply(ctx, config) {
  const options = () => resolveOptions(plainOptions(config))
  // Fail loud at load instead of at the first user request.
  options()

  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  const resolveApiKey = async (current) => {
    const ref = current.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && hit.value.length > 0) return assertUsableApiKey(hit.value, 'llm-gemini-argon', ref)
    }
    const ambient = launchEnvironmentOf(ctx).get(ref)
    if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, 'llm-gemini-argon', ref)
    throw new LlmError(
      `llm-gemini-argon: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const resolveAuth = async (force = false) => {
    const current = options()
    if (current.auth === 'service-account') return serviceAccountAuth(current, force)
    return { kind: 'api-key', headers: { 'x-goog-api-key': await resolveApiKey(current) } }
  }

  const settingsNs = ctx.fiber.entry?.options.id ?? name

  const adapter = new GeminiArgonAdapter({
    options,
    resolveAuth,
    resolveAttachments: () => ctx.get('attachments'),
    imageAccess: (ref) => {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) return undefined
      return resolveImageAttachmentAccess(
        attachments,
        (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
        ref,
      )
    },
  })
  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: 'Google Vertex AI',
    settingsNs,
    settingsPath: [],
  }])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)

  ctx.llm.registerModelDiscovery(settingsNs, async (_request, signal) => {
    const current = options()
    let auth = await resolveAuth()
    try {
      await probeModel(current, auth, signal)
    } catch (error) {
      if (error instanceof LlmError && error.code === 'AUTH' && auth.invalidate !== undefined) {
        auth.invalidate()
        auth = await resolveAuth(true)
        await probeModel(current, auth, signal)
      } else {
        throw error
      }
    }
    return [{ id: current.model, name: current.modelName }]
  })

  ctx.on('loader/volatile-update', () => {
    try {
      options()
      registration.replace([PROVIDER])
    } catch (error) {
      ctx.logger.warn('llm-gemini-argon: configuration rejected; keeping the previous registration')
      ctx.logger.warn(error)
    }
  })
}
