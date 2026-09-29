import { getPlaceholderRegex } from "./session.js"

/**
 * 还原字符串中的占位符；若占位符不在映射表中，则保持原样。
 * @param {string} input
 * @param {{ prefix: string, lookup(ph: string): string | undefined }} session
 */
export function restoreText(input, session) {
  const text = String(input ?? "")
  if (!text) return text
  const re = getPlaceholderRegex(session.prefix)
  return text.replace(re, (ph) => session.lookup(ph) ?? ph)
}

function skipWhitespace(input, start) {
  let index = start
  while (/\s/.test(input[index] ?? "")) index++
  return index
}

function stringEnd(input, start) {
  for (let index = start + 1; index < input.length; index++) {
    if (input[index] === "\\") {
      index++
      continue
    }
    if (input[index] === '"') return index + 1
  }
  throw new SyntaxError("Unterminated JSON string")
}

function shouldKeepPlaceholder(key, parent) {
  if (key === "arguments" || key === "partial_json") return true
  return key === "delta" && parent?.type === "response.function_call_arguments.delta"
}

function rewriteJsonValue(input, start, value, session, key = "", parent = null) {
  const first = input[start]
  if (first === '"') {
    const end = stringEnd(input, start)
    const raw = input.slice(start, end)
    if (shouldKeepPlaceholder(key, parent)) return { text: raw, end }
    const decoded = JSON.parse(raw)
    const restored = restoreText(decoded, session)
    return { text: restored === decoded ? raw : JSON.stringify(restored), end }
  }

  if (first === "[") {
    let index = start + 1
    let itemIndex = 0
    let output = "["
    for (;;) {
      const valueStart = skipWhitespace(input, index)
      output += input.slice(index, valueStart)
      if (input[valueStart] === "]") return { text: `${output}]`, end: valueStart + 1 }
      const item = rewriteJsonValue(input, valueStart, value?.[itemIndex], session, "", value)
      output += item.text
      index = skipWhitespace(input, item.end)
      output += input.slice(item.end, index)
      if (input[index] === "]") return { text: `${output}]`, end: index + 1 }
      if (input[index] !== ",") throw new SyntaxError("Invalid JSON array")
      output += ","
      index++
      itemIndex++
    }
  }

  if (first === "{") {
    let index = start + 1
    let output = "{"
    for (;;) {
      const keyStart = skipWhitespace(input, index)
      output += input.slice(index, keyStart)
      if (input[keyStart] === "}") return { text: `${output}}`, end: keyStart + 1 }
      if (input[keyStart] !== '"') throw new SyntaxError("Invalid JSON object key")
      const keyEnd = stringEnd(input, keyStart)
      const childKey = JSON.parse(input.slice(keyStart, keyEnd))
      const colon = skipWhitespace(input, keyEnd)
      if (input[colon] !== ":") throw new SyntaxError("Invalid JSON object")
      const valueStart = skipWhitespace(input, colon + 1)
      output += input.slice(keyStart, valueStart)
      const child = rewriteJsonValue(input, valueStart, value?.[childKey], session, childKey, value)
      output += child.text
      index = skipWhitespace(input, child.end)
      output += input.slice(child.end, index)
      if (input[index] === "}") return { text: `${output}}`, end: index + 1 }
      if (input[index] !== ",") throw new SyntaxError("Invalid JSON object")
      output += ","
      index++
    }
  }

  let end = start
  while (end < input.length && !/[\s,}\]]/.test(input[end])) end++
  return { text: input.slice(start, end), end }
}

function restoreJsonDocument(input, session) {
  try {
    const value = JSON.parse(input)
    const start = skipWhitespace(input, 0)
    const rewritten = rewriteJsonValue(input, start, value, session)
    return input.slice(0, start) + rewritten.text + input.slice(rewritten.end)
  } catch {
    return input
  }
}

function hasRestorablePlaceholder(input, session) {
  for (const match of input.matchAll(getPlaceholderRegex(session.prefix))) {
    if (session.lookup(match[0]) !== undefined) return true
  }
  return false
}

/**
 * 按 provider 响应协议还原占位符，避免破坏 JSON 与 SSE framing。
 * @param {string} input
 * @param {string} contentType
 * @param {{ prefix: string, lookup(ph: string): string | undefined }} session
 */
export function restoreResponseText(input, contentType, session) {
  const text = String(input ?? "")
  if (!text) return text
  if (!hasRestorablePlaceholder(text, session)) return text
  const mediaType = String(contentType ?? "").toLowerCase()
  if (mediaType.includes("json")) return restoreJsonDocument(text, session)
  if (mediaType.includes("event-stream")) {
    return text.replace(/^(\s*data:\s?)(.*)$/gm, (_line, prefix, data) => {
      if (data.trim() === "[DONE]") return `${prefix}${data}`
      return `${prefix}${restoreJsonDocument(data, session)}`
    })
  }
  return restoreText(text, session)
}
