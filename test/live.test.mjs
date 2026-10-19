/**
 * Live smoke test for the Gemini 4 Argon adapter.
 *
 * Run from a directory that can resolve @deepseek-ai/dsh-llm (inside the DSH
 * installation tree) with GOOGLE_VERTEX_API_KEY and GOOGLE_CLOUD_PROJECT set:
 *
 *   GKEY=... GOOGLE_CLOUD_PROJECT=... node test/live.test.mjs
 */
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { GeminiArgonAdapter, resolveOptions } from 'dsh-gemini-argon'

const apiKey = process.env.GKEY ?? process.env.GOOGLE_VERTEX_API_KEY
if (apiKey === undefined) throw new Error('set GKEY or GOOGLE_VERTEX_API_KEY')
const project = process.env.GOOGLE_CLOUD_PROJECT
if (project === undefined) throw new Error('set GOOGLE_CLOUD_PROJECT')

const config = resolveOptions({
  project,
  location: process.env.GOOGLE_CLOUD_LOCATION ?? 'global',
  model: 'gemini-4-argon',
  modelName: 'Gemini 4 Argon',
})

const adapter = new GeminiArgonAdapter({
  options: () => config,
  resolveAuth: async () => ({ kind: 'api-key', headers: { 'x-goog-api-key': apiKey } }),
})

async function call(messages, { tools = [], system = 'You are a terse test assistant.' } = {}) {
  const assembler = new BlockAssembler()
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'gemini-argon',
    model: 'gemini-4-argon',
    system,
    messages,
    tools,
  })) {
    chunks.push(chunk)
    assembler.push(chunk)
  }
  return { chunks, assembler, message: assembler.message({ provider: 'gemini-argon', model: 'gemini-4-argon', replayState: assembler.replayState }) }
}

const first = await call([{ role: 'user', content: [{ type: 'text', text: 'Say hi in exactly three words.' }] }])
console.log('text answer:', JSON.stringify(first.message.content))
console.log('usage:', JSON.stringify(first.assembler.usage))
console.log('finish:', JSON.stringify(first.assembler.finish))

const tool = {
  name: 'add',
  description: 'Add two integers',
  parameters: {
    type: 'object',
    properties: { a: { type: 'integer' }, b: { type: 'integer' } },
    required: ['a', 'b'],
  },
}

const second = await call(
  [{ role: 'user', content: [{ type: 'text', text: 'Use the add tool to add 2 and 3. Then stop.' }] }],
  { tools: [tool] },
)
console.log('tool blocks:', JSON.stringify(second.message.content))

const toolCall = second.message.content.find((block) => block.type === 'tool-call')
if (toolCall === undefined) throw new Error('expected a tool call')

const third = await call(
  [
    { role: 'user', content: [{ type: 'text', text: 'Use the add tool to add 2 and 3. Then stop.' }] },
    second.message,
    { role: 'tool', toolCallId: toolCall.id, content: [{ type: 'text', text: '5' }] },
  ],
  { tools: [tool] },
)
console.log('after tool:', JSON.stringify(third.message.content))
console.log('finish:', JSON.stringify(third.assembler.finish))

const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUElEQVR42u3PQQkAAAgEsEvi2/55DGME38JgBZapfi0CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApcFEWchD98r0aIAAAAASUVORK5CYII=',
  'base64',
)

const imageAdapter = new GeminiArgonAdapter({
  options: () => config,
  resolveAuth: async () => ({ kind: 'api-key', headers: { 'x-goog-api-key': apiKey } }),
  resolveAttachments: () => ({
    readImageRequest: async () => ({
      mediaType: 'image/png',
      data: RED_PNG,
      bytes: RED_PNG.byteLength,
      width: 64,
      height: 64,
    }),
  }),
})

const imageAssembler = new BlockAssembler()
for await (const chunk of imageAdapter.stream({
  provider: 'gemini-argon',
  model: 'gemini-4-argon',
  system: 'Answer with one word.',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is the dominant color of this image?' },
      { type: 'image', attachment: { attachmentId: 'sha256:red', mediaType: 'image/png', width: 64, height: 64, bytes: RED_PNG.byteLength } },
    ],
  }],
})) {
  imageAssembler.push(chunk)
}
const imageAnswer = imageAssembler.blocks().filter((block) => block.type === 'text').map((block) => block.text).join('')
console.log('image answer:', JSON.stringify(imageAnswer))
if (!/red/i.test(imageAnswer)) throw new Error('expected the model to name the red image')

const degraded = await call([
  { role: 'user', content: [{ type: 'text', text: 'Use the add tool to add 2 and 3.' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Calling add.' },
      { type: 'tool-call', id: 'call-foreign', name: 'add', arguments: '{"a":2,"b":3}' },
    ],
  },
  { role: 'tool', toolCallId: 'call-foreign', content: [{ type: 'text', text: '5' }] },
  { role: 'user', content: [{ type: 'text', text: 'What result did the tool return? Answer with just the number.' }] },
])
const degradedText = degraded.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
console.log('degraded answer:', JSON.stringify(degradedText))
if (!degradedText.includes('5')) throw new Error('expected the degraded tool exchange to preserve the result')
