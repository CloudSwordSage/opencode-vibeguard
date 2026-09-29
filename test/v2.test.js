import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import * as entry from "../src/index.js"
import { getConfigCandidates } from "../src/config.js"

const plugin = entry.default
const { VibeGuardPrivacy } = entry

async function withConfig(config, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-vibeguard-"))
  await writeFile(path.join(directory, "vibeguard.config.json"), JSON.stringify(config))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function createContext(directory) {
  const sessionHooks = new Map()
  const toolHooks = new Map()
  return {
    context: {
      location: { directory },
      options: {},
      session: {
        async hook(name, callback) {
          sessionHooks.set(name, callback)
        },
      },
      tool: {
        async hook(name, callback) {
          toolHooks.set(name, callback)
        },
      },
    },
    sessionHooks,
    toolHooks,
  }
}

test("exports OpenCode V2 definition while retaining the V1 entry", () => {
  assert.equal(plugin.id, "opencode-vibeguard")
  assert.equal(typeof plugin.setup, "function")
  assert.equal(typeof plugin.server, "function")
  assert.equal(typeof VibeGuardPrivacy, "function")
})

test("V2 hooks redact model context and restore tool input and HTTP responses", async () => {
  await withConfig(
    {
      enabled: true,
      patterns: { keywords: [{ value: "secret-value", category: "SECRET" }] },
    },
    async (directory) => {
      const { context, sessionHooks, toolHooks } = createContext(directory)
      await plugin.setup(context)

      assert.deepEqual([...sessionHooks.keys()].sort(), ["compaction", "context", "generate", "http.response", "title"])
      assert.deepEqual([...toolHooks.keys()], ["execute.before"])

      const event = {
        sessionID: "session-1",
        system: [{ type: "text", text: "system secret-value" }],
        messages: [
          { role: "user", content: [{ type: "text", text: "user secret-value" }] },
          {
            role: "assistant",
            native: { replay: "secret-value" },
            content: [
              {
                type: "reasoning",
                text: "reasoning secret-value",
                providerMetadata: { provider: { replay: "secret-value" } },
              },
              { type: "tool-call", id: "call-1", name: "example", input: { token: "secret-value" } },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                id: "call-1",
                name: "example",
                result: {
                  type: "content",
                  value: [
                    { type: "text", text: "secret-value" },
                    { type: "file", uri: "https://example.com/?token=secret-value", name: "secret-value.txt" },
                  ],
                },
              },
            ],
          },
        ],
        options: {},
        tools: {},
      }

      await sessionHooks.get("context")(event)
      const serialized = JSON.stringify(event)
      assert.equal(serialized.includes("secret-value"), false)

      const placeholder = event.messages[1].content[1].input.token
      assert.match(placeholder, /^__VG_SECRET_[a-f0-9]{12}__$/)

      const toolEvent = { sessionID: "session-1", input: { token: placeholder } }
      await toolHooks.get("execute.before")(toolEvent)
      assert.equal(toolEvent.input.token, "secret-value")

      const scalarToolEvent = { sessionID: "session-1", input: placeholder }
      await toolHooks.get("execute.before")(scalarToolEvent)
      assert.equal(scalarToolEvent.input, "secret-value")

      const responseEvent = {
        sessionID: "session-1",
        response: new Response(`data: {"text":"${placeholder}"}\n\n`, {
          status: 200,
          statusText: "OK",
          headers: { "content-length": "1", "content-type": "text/event-stream" },
        }),
      }
      await sessionHooks.get("http.response")(responseEvent)
      assert.equal(await responseEvent.response.text(), 'data: {"text":"secret-value"}\n\n')
      assert.equal(responseEvent.response.headers.has("content-length"), false)
      assert.equal(responseEvent.response.headers.get("content-type"), "text/event-stream")

      const untouched = new Response('{ "text": "normal" }\n', {
        headers: { "content-type": "application/json", "x-test": "unchanged" },
      })
      const untouchedEvent = { sessionID: "session-1", response: untouched }
      await sessionHooks.get("http.response")(untouchedEvent)
      assert.equal(untouchedEvent.response, untouched)
    },
  )
})

test("HTTP response restoration preserves JSON escaping", async () => {
  await withConfig(
    {
      enabled: true,
      patterns: { keywords: [{ value: 'secret"value', category: "SECRET" }] },
    },
    async (directory) => {
      const { context, sessionHooks } = createContext(directory)
      await plugin.setup(context)

      const requestEvent = {
        sessionID: "session-json",
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: 'secret"value' }] }],
        options: {},
        tools: {},
      }
      await sessionHooks.get("context")(requestEvent)
      const placeholder = requestEvent.messages[0].content[0].text

      const responseEvent = {
        sessionID: "session-json",
        response: new Response(JSON.stringify({ text: placeholder }), {
          headers: { "content-type": "Application/JSON" },
        }),
      }
      await sessionHooks.get("http.response")(responseEvent)
      assert.deepEqual(JSON.parse(await responseEvent.response.text()), { text: 'secret"value' })
    },
  )
})

test("HTTP response leaves nested tool arguments valid for execute.before restoration", async () => {
  await withConfig(
    {
      enabled: true,
      patterns: { keywords: [{ value: 'secret"value', category: "SECRET" }] },
    },
    async (directory) => {
      const { context, sessionHooks, toolHooks } = createContext(directory)
      await plugin.setup(context)

      const requestEvent = {
        sessionID: "session-tool-json",
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: 'secret"value' }] }],
        options: {},
        tools: {},
      }
      await sessionHooks.get("context")(requestEvent)
      const placeholder = requestEvent.messages[0].content[0].text
      const providerBody = {
        choices: [
          {
            message: {
              tool_calls: [{ function: { arguments: JSON.stringify({ token: placeholder }) } }],
            },
          },
        ],
      }
      const responseEvent = {
        sessionID: "session-tool-json",
        response: new Response(JSON.stringify(providerBody), {
          headers: { "content-type": "application/json" },
        }),
      }

      await sessionHooks.get("http.response")(responseEvent)
      const restoredBody = JSON.parse(await responseEvent.response.text())
      const input = JSON.parse(restoredBody.choices[0].message.tool_calls[0].function.arguments)
      assert.equal(input.token, placeholder)

      const toolEvent = { sessionID: "session-tool-json", input }
      await toolHooks.get("execute.before")(toolEvent)
      assert.equal(toolEvent.input.token, 'secret"value')
    },
  )
})

test("OpenAI Responses function argument deltas stay valid until execute.before", async () => {
  await withConfig(
    {
      enabled: true,
      patterns: { keywords: [{ value: 'secret"value', category: "SECRET" }] },
    },
    async (directory) => {
      const { context, sessionHooks } = createContext(directory)
      await plugin.setup(context)

      const requestEvent = {
        sessionID: "session-responses-delta",
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: 'secret"value' }] }],
        options: {},
        tools: {},
      }
      await sessionHooks.get("context")(requestEvent)
      const placeholder = requestEvent.messages[0].content[0].text
      const providerEvent = {
        type: "response.function_call_arguments.delta",
        delta: JSON.stringify({ token: placeholder }),
      }
      const responseEvent = {
        sessionID: "session-responses-delta",
        response: new Response(`data: ${JSON.stringify(providerEvent)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
      }

      await sessionHooks.get("http.response")(responseEvent)
      const data = (await responseEvent.response.text()).trim().slice("data: ".length)
      const restoredEvent = JSON.parse(data)
      assert.deepEqual(JSON.parse(restoredEvent.delta), { token: placeholder })
    },
  )
})

test("HTTP response restoration preserves numeric tokens byte-for-byte", async () => {
  await withConfig(
    {
      enabled: true,
      patterns: { keywords: [{ value: "secret-value", category: "SECRET" }] },
    },
    async (directory) => {
      const { context, sessionHooks } = createContext(directory)
      await plugin.setup(context)

      const requestEvent = {
        sessionID: "session-large-number",
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: "secret-value" }] }],
        options: {},
        tools: {},
      }
      await sessionHooks.get("context")(requestEvent)
      const placeholder = requestEvent.messages[0].content[0].text
      const responseEvent = {
        sessionID: "session-large-number",
        response: new Response(`{"id":9007199254740993,"text":"${placeholder}"}`, {
          headers: { "content-type": "application/json" },
        }),
      }

      await sessionHooks.get("http.response")(responseEvent)
      assert.equal(await responseEvent.response.text(), '{"id":9007199254740993,"text":"secret-value"}')
    },
  )
})

test("disabled configuration does not register V2 hooks", async () => {
  await withConfig({ enabled: false }, async (directory) => {
    const { context, sessionHooks, toolHooks } = createContext(directory)
    await plugin.setup(context)
    assert.equal(sessionHooks.size, 0)
    assert.equal(toolHooks.size, 0)
  })
})

test("global configuration honors XDG_CONFIG_HOME", () => {
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = path.join("root", "xdg")
  try {
    const candidates = getConfigCandidates(path.join("root", "project"))
    assert.equal(candidates.at(-1), path.join("root", "xdg", "opencode", "vibeguard.config.json"))
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
  }
})
