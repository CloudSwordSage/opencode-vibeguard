import { loadConfig } from "./config.js"
import { buildPatternSet } from "./patterns.js"
import { PlaceholderSession } from "./session.js"
import { redactText } from "./engine.js"
import { redactDeep, restoreDeep } from "./deep.js"
import { restoreResponseText, restoreText } from "./restore.js"

async function createState(directory) {
  const config = await loadConfig(directory)
  const debug = Boolean(process.env.OPENCODE_VIBEGUARD_DEBUG) || Boolean(config.debug)

  if (debug) {
    const from = config.loadedFrom ? config.loadedFrom : "未找到（插件将 no-op）"
    console.log(`[opencode-vibeguard] 配置：${from} enabled=${config.enabled}`)
  }

  if (!config.enabled) return null

  const patterns = buildPatternSet(config.patterns)
  const sessions = new Map()

  const getSession = (sessionID) => {
    const key = String(sessionID ?? "")
    if (!key) return null
    const existing = sessions.get(key)
    if (existing) return existing
    const created = new PlaceholderSession({
      prefix: config.prefix,
      ttlMs: config.ttlMs,
      maxMappings: config.maxMappings,
    })
    sessions.set(key, created)
    return created
  }

  return { debug, getSession, patterns }
}

function redactValue(value, patterns, session) {
  if (typeof value === "string") return redactText(value, patterns, session).text
  if (value && typeof value === "object") redactDeep(value, patterns, session)
  return value
}

function redactV2Request(event, state, session) {
  let changedTextParts = 0
  const redactProperty = (owner, key) => {
    if (typeof owner?.[key] !== "string" || !owner[key]) return
    const before = owner[key]
    owner[key] = redactText(before, state.patterns, session).text
    if (owner[key] !== before) changedTextParts++
  }

  for (const part of Array.isArray(event.system) ? event.system : []) {
    if (part?.type !== "text") continue
    redactProperty(part, "text")
    redactDeep(part.metadata, state.patterns, session)
  }

  for (const message of Array.isArray(event.messages) ? event.messages : []) {
    redactDeep(message?.metadata, state.patterns, session)
    redactDeep(message?.providerMetadata, state.patterns, session)
    redactDeep(message?.native, state.patterns, session)
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      if (!part || typeof part !== "object") continue
      redactDeep(part.metadata, state.patterns, session)
      redactDeep(part.providerMetadata, state.patterns, session)
      if (part.type === "text" || part.type === "reasoning" || part.type === "compaction") {
        redactProperty(part, "text")
        continue
      }
      if (part.type === "tool-call") {
        part.input = redactValue(part.input, state.patterns, session)
        continue
      }
      if (part.type === "media") {
        redactProperty(part, "filename")
        if (part.media?.source?.type === "url") redactProperty(part.media.source, "url")
        continue
      }
      if (part.type !== "tool-result" || !part.result || typeof part.result !== "object") continue
      if (part.result.type === "content" && Array.isArray(part.result.value)) {
        for (const content of part.result.value) {
          if (content?.type === "text") redactProperty(content, "text")
          if (content?.type === "file") {
            redactProperty(content, "uri")
            redactProperty(content, "name")
          }
        }
        continue
      }
      part.result.value = redactValue(part.result.value, state.patterns, session)
    }
  }

  if (state.debug && changedTextParts > 0) {
    console.log(`[opencode-vibeguard] 本次请求前脱敏：已修改 ${changedTextParts} 处文本片段`)
  }
}

/**
 * OpenCode 插件入口：
 * - `experimental.chat.messages.transform`：LLM 请求前对全部消息做脱敏（保证 provider 永远看不到真实值）
 * - `tool.execute.before`：工具执行前还原占位符（保证本机执行拿到真实值）
 *
 * 说明：为了降低误用风险，本插件在“找不到配置文件或 enabled=false”时为 no-op。
 */
export const VibeGuardPrivacy = async (ctx = {}) => {
  const state = await createState(ctx.directory)
  if (!state) return {}
  const { debug, getSession, patterns } = state

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      const msgs = output?.messages
      if (!Array.isArray(msgs) || msgs.length === 0) return

      const sessionID = msgs[0]?.info?.sessionID ?? msgs[0]?.parts?.[0]?.sessionID
      const session = getSession(sessionID)
      if (!session) return

      session.cleanup()

      let changedTextParts = 0

      for (const msg of msgs) {
        const parts = Array.isArray(msg?.parts) ? msg.parts : []
        for (const part of parts) {
          if (!part) continue

          // 普通文本（用户/助手）
          if (part.type === "text") {
            if (part.ignored) continue
            if (!part.text || typeof part.text !== "string") continue
            const before = part.text
            const after = redactText(before, patterns, session).text
            if (after !== before) changedTextParts++
            part.text = after
            continue
          }

          // 推理文本（部分模型/配置会进入 prompt）
          if (part.type === "reasoning") {
            if (!part.text || typeof part.text !== "string") continue
            const before = part.text
            const after = redactText(before, patterns, session).text
            if (after !== before) changedTextParts++
            part.text = after
            continue
          }

          // 工具调用/输出：最常见的泄漏来源（例如读取 .env）
          if (part.type === "tool") {
            const state = part.state
            if (!state || typeof state !== "object") continue

            // 统一把工具输入也做深度脱敏：真实执行的 args 会包含明文（由 tool.execute.before 还原），
            // 如果不在这里再脱敏一次，后续回合会把明文 args 带给 LLM。
            if (state.input && typeof state.input === "object") {
              redactDeep(state.input, patterns, session)
            }

            if (state.status === "completed" && typeof state.output === "string") {
              const before = state.output
              const after = redactText(before, patterns, session).text
              if (after !== before) changedTextParts++
              state.output = after
              continue
            }
            if (state.status === "error" && typeof state.error === "string") {
              const before = state.error
              const after = redactText(before, patterns, session).text
              if (after !== before) changedTextParts++
              state.error = after
              continue
            }
            if (state.status === "pending" && typeof state.raw === "string") {
              const before = state.raw
              const after = redactText(before, patterns, session).text
              if (after !== before) changedTextParts++
              state.raw = after
              continue
            }
          }
        }
      }

      if (debug && changedTextParts > 0) {
        console.log(`[opencode-vibeguard] 本次请求前脱敏：已修改 ${changedTextParts} 处文本片段`)
      }
    },

    "experimental.text.complete": async (input, output) => {
      if (!output || typeof output !== "object") return
      if (typeof output.text !== "string" || !output.text) return
      const session = getSession(input?.sessionID)
      if (!session) return
      session.cleanup()
      const before = output.text
      const after = restoreText(before, session)
      output.text = after
      if (debug && after !== before) {
        console.log("[opencode-vibeguard] 本次响应完成后还原：已修改 1 处文本片段")
      }
    },

    "tool.execute.before": async (input, output) => {
      const session = getSession(input?.sessionID)
      if (!session) return
      session.cleanup()
      restoreDeep(output?.args, session)
    },
  }
}

/**
 * OpenCode V2 插件定义，同时通过 `server` 保留 V1 对象入口。
 */
const plugin = {
  id: "opencode-vibeguard",

  async setup(ctx) {
    const directory = ctx?.location?.directory ?? ctx?.directory
    const state = await createState(directory)
    if (!state) return

    const redactRequest = (event) => {
      const session = state.getSession(event?.sessionID)
      if (!session) return
      session.cleanup()
      redactV2Request(event, state, session)
    }

    for (const hook of ["context", "compaction", "generate", "title"]) {
      await ctx.session.hook(hook, redactRequest)
    }

    await ctx.session.hook("http.response", async (event) => {
      const session = state.getSession(event?.sessionID)
      if (!session || !(event?.response instanceof Response)) return
      session.cleanup()

      try {
        const response = event.response
        const before = await response.clone().text()
        const contentType = response.headers.get("content-type") ?? ""
        const after = restoreResponseText(before, contentType, session)
        if (after === before) return

        const headers = new Headers(response.headers)
        headers.delete("content-length")
        headers.delete("content-encoding")
        event.response = new Response(after, {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
        if (state.debug) console.log("[opencode-vibeguard] 本次响应完成后还原：已修改 1 处文本片段")
      } catch {
        console.error("[opencode-vibeguard] 响应还原失败，已保留原始响应")
      }
    })

    await ctx.tool.hook("execute.before", (event) => {
      const session = state.getSession(event?.sessionID)
      if (!session) return
      session.cleanup()
      if (typeof event.input === "string") event.input = restoreText(event.input, session)
      else restoreDeep(event.input, session)
    })
  },

  server: VibeGuardPrivacy,
}

export default plugin
