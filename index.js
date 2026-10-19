/**
 * Gemini 4 Argon (Google Vertex AI) provider plugin for DeepSeek Harness.
 *
 * The plugin registers one LLM route, `gemini-argon`, and talks to Vertex AI's
 * native `streamGenerateContent` API with an Express-mode API key
 * (`x-goog-api-key`). Text, streaming tool calls, usage accounting, and
 * optional thinking summaries are supported.
 *
 * Design notes:
 * - Express keys are region-scoped for the shorthand publisher path, so the
 *   request uses the explicit `projects/{project}/locations/{location}` form.
 *   `location: "global"` is what makes `gemini-4-argon` reachable for the
 *   Express key this plugin was written for.
 * - Thinking is off by default: replaying tool-call history with a thinking
 *   level enabled can stall on Vertex, so it is opt-in.
 * - Every request carries `attributionHeaders()`, as the LLM seam requires.
 *
 * @module dsh-gemini-argon
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  assertUsableApiKey,
  attributionHeaders,
  isContextWindowExceededError,
  isQuotaExceededError,
} from '@deepseek-ai/dsh-llm'
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
const THINKING_LEVELS = ['off', 'low', 'medium', 'high']
/** Error bodies are diagnostics, not payloads; keep logs and messages bounded. */
const MAX_ERROR_BODY = 4000

export const Config = z.object({
  /** Credential reference resolved through the credentials service (or the launch environment). */
  apiKeyEnv: z.string().default(DEFAULT_API_KEY_ENV).role('credential-ref').volatile(),
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
  /** Default reasoning level; `off` sends no thinkingConfig at all. */
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

  const project = String(raw.project ?? '').trim() || String(process.env.GOOGLE_CLOUD_PROJECT ?? '').trim()
  if (project.length === 0) {
    throw new Error('llm-gemini-argon: project is required; set config.project or export GOOGLE_CLOUD_PROJECT (Express API keys do not carry a project)')
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
  const apiKeyEnv = String(raw.apiKeyEnv ?? DEFAULT_API_KEY_ENV).trim()
  if (apiKeyEnv.length === 0) throw new Error('llm-gemini-argon: apiKeyEnv must not be empty')

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
    baseURL,
    project,
    location,
    model,
    modelName,
    contextWindow: positiveInteger(raw.contextWindow ?? DEFAULT_CONTEXT_WINDOW, 'contextWindow'),
    maxTokens: positiveInteger(raw.maxTokens ?? DEFAULT_MAX_TOKENS, 'maxTokens'),
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

/**
 * Convert provider-neutral messages into one Gemini `GenerateContent` body.
 * Exported for tests; the adapter is the only production caller.
 */
export function buildRequestBody(options, config) {
  const systemTexts = []
  const contents = []
  const callNames = new Map()
  const thinkingLevel = String(options.reasoningEffort ?? config.thinkingLevel)
  if (typeof options.system === 'string' && options.system.length > 0) systemTexts.push(options.system)

  const push = (role, parts) => {
    if (parts.length === 0) return
    const previous = contents.at(-1)
    if (previous?.role === role) previous.parts.push(...parts)
    else contents.push({ role, parts })
  }

  for (const message of options.messages ?? []) {
    if (message.role === 'developer' || message.role === 'system') {
      const text = textOf(message.content)
      if (text.length > 0) systemTexts.push(text)
      continue
    }

    if (message.role === 'user') {
      const parts = []
      for (const block of message.content) {
        if (block.type === 'text' && block.text.length > 0) parts.push({ text: block.text })
        // Input modalities are text-only, so the runtime projects images to text
        // before dispatch. A stray image block is skipped rather than guessed at.
      }
      push('user', parts)
      continue
    }

    if (message.role === 'assistant') {
      const replay = readReplay(message.source?.replayState)
      if (thinkingLevel !== 'off' && replay?.parts !== undefined) {
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
          parts.push({
            functionCall: { name: block.name, args: parseArguments(block.arguments) },
            ...(typeof signature === 'string' ? { thoughtSignature: signature } : {}),
          })
        }
      }
      push('model', parts)
      continue
    }

    if (message.role === 'tool') {
      const name = callNames.get(message.toolCallId) ?? 'tool'
      const text = textOf(message.content)
      const response = message.isError === true ? { error: text || 'tool failed' } : { result: text }
      push('user', [{ functionResponse: { name, response } }])
      continue
    }
  }

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
      ...(thinkingLevel !== 'off'
        ? { thinkingConfig: { includeThoughts: true, thinkingLevel: thinkingLevel.toUpperCase() } }
        : {}),
    },
  }
}

/** Decode `text/event-stream` frames from a fetch body. */
async function* parseSse(body) {
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

/** One route's Vertex AI streaming adapter. */
export class GeminiArgonAdapter extends LlmAdapter {
  constructor({ options, resolveApiKey }) {
    super()
    this.options = options
    this.resolveApiKey = resolveApiKey
  }

  providerInfo(provider) {
    return { id: provider, name: 'Google Vertex AI' }
  }

  async listModels(provider) {
    const config = this.options()
    return [{
      provider,
      id: config.model,
      name: config.modelName,
      description: 'Gemini 4 Argon on Google Vertex AI (Express API key)',
      inputModalities: ['text'],
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
      inputModalities: ['text'],
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

  /**
   * Stream one model call as harness chunks.
   * @param {object} options - provider-neutral request.
   */
  async *stream(options) {
    const config = this.options()
    const apiKey = await this.resolveApiKey()
    const body = buildRequestBody(options, config)
    const url = endpointOf(config, options.model)

    let response
    try {
      const proxy = await proxyFor(config, url, process.env)
      response = await fetchRequest(url, {
        method: 'POST',
        signal: options.signal,
        redirect: 'error',
        headers: {
          ...attributionHeaders(),
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      }, proxy)
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('llm-gemini-argon: request aborted', 'ABORTED', { cause: error })
      throw new LlmError('llm-gemini-argon: Vertex AI transport failed', 'TRANSPORT', { cause: error })
    }

    if (!response.ok) throw await httpFailure(response)
    if (response.body === null) throw new LlmError('llm-gemini-argon: Vertex AI returned no response body', EMPTY_RESPONSE_CODE)

    try {
      yield* translate(parseSse(response.body), options, config)
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('llm-gemini-argon: request aborted', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw new LlmError('llm-gemini-argon: Vertex AI stream failed', 'TRANSPORT', { cause: error })
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

  const resolveApiKey = async () => {
    const ref = options().apiKeyEnv
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

  const adapter = new GeminiArgonAdapter({ options, resolveApiKey })
  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: 'Google Vertex AI',
    settingsNs: ctx.fiber.entry?.options.id ?? name,
    settingsPath: [],
  }])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)

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
