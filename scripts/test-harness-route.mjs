#!/usr/bin/env node
/**
 * 验证「照 harness 的做法改造」是否可行，只测三件没验证过的事：
 *
 *   1. 客户端工具（带 input_schema 的 function calling）会不会也触发 32K 扩展模式
 *      —— 这是完整客户端工具循环的地基。harness 主对话带一堆客户端工具跑长上下文，
 *         但那是它自己的适配器；我们走 Anthropic 兼容端点，必须实测。
 *   2. stream: true 会不会单独触发（应用一直用流式，之前的测试全是非流式）。
 *   3. 独立的 POST /v1/tools/search 是否对这个 key 开放
 *      —— 这是「预取式搜索」的地基，不依赖模型、不声明任何 tools。
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-xxx node scripts/test-harness-route.mjs
 *
 * 可选环境变量：
 *   DEEPSEEK_MODEL   默认 deepseek-flash
 *   DEEPSEEK_API_KEY 必填
 *   API_BASE         默认 https://api.deepseek.com
 *   LONG_FILE        长文本文件，默认 I:/workBuddyworkspace/long-text-40k.txt
 *   LONG_CHARS       文件不存在时按此长度生成，默认 80000
 *   DRY_RUN=1        只打印分组
 *
 * 成本：3 次约 5 万 token 的长请求 + 3 次短请求 ≈ 15 万输入 token，空闲时段约 ¥0.15。
 */

import { readFileSync, existsSync } from 'node:fs'

const API_BASE = (process.env.API_BASE ?? 'https://api.deepseek.com').replace(/\/$/, '')
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'
const KEY = process.env.DEEPSEEK_API_KEY ?? ''
const DRY_RUN = process.env.DRY_RUN === '1'
const LONG_FILE = process.env.LONG_FILE ?? 'I:/workBuddyworkspace/long-text-40k.txt'
const LONG_CHARS = Number(process.env.LONG_CHARS ?? 80_000)

const SYSTEM = '该助手为DeepSeek，由深度求索公司创造。'

/** 长文本优先用已经生成好的文件，保证和应用里那条失败请求内容一致 */
const UNIT =
  '这是一段用于测试单次输入长度上限的占位文本，没有实际含义，只用来把请求的上下文推到阈值以上。'
const longText = existsSync(LONG_FILE)
  ? `请阅读以下材料，然后只用一句话回答：材料开头和结尾的编号分别是什么？\n\n${readFileSync(LONG_FILE, 'utf8')}`
  : UNIT.repeat(Math.ceil(LONG_CHARS / UNIT.length)).slice(0, LONG_CHARS)

/** 客户端工具：和 harness 的 web_search 同形（name / description / input_schema） */
const CLIENT_TOOL = {
  name: 'web_search',
  description:
    'Search the web for fresh information. Use it when the answer depends on facts you do not know or that may have changed.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      count: { type: 'integer', description: 'Number of results, 1-10' },
    },
    required: ['query'],
  },
}

const maskKey = (key) => (key ? `${key.slice(0, 3)}…${key.slice(-4)}` : '(未设置)')
const isTooLong = (message) => /user input too long/i.test(message ?? '')
const totalTokens = (usage) =>
  (usage?.input_tokens ?? 0) +
  (usage?.cache_read_input_tokens ?? 0) +
  (usage?.cache_creation_input_tokens ?? 0)

/** 非流式请求 */
const call = async (body, extraHeaders = {}) => {
  const started = Date.now()
  const response = await fetch(`${API_BASE}/anthropic/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: MODEL,
      system: SYSTEM,
      max_tokens: 16,
      thinking: { type: 'disabled' },
      stream: false,
      ...body,
    }),
    signal: AbortSignal.timeout(180_000),
  })
  const text = await response.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    // 非 JSON 响应保留原文
  }
  return {
    status: response.status,
    ms: Date.now() - started,
    message: payload?.error?.message ?? (response.ok ? '' : text.slice(0, 200)),
    usage: payload?.usage ?? null,
    payload,
  }
}

/** 测试纯 document(file_id) 在不带 safety_check / tools / title 时是否单独触发 32K */
const callDocumentFile = async () => {
  const form = new FormData()
  form.append('purpose', 'user_data')
  form.append('file', new Blob([longText], { type: 'text/plain' }), 'long-test.txt')
  const uploadRes = await fetch(`${API_BASE}/anthropic/v1/files`, {
    method: 'POST',
    headers: {
      'x-api-key': KEY,
      'anthropic-beta': 'files-api-2025-04-14',
    },
    body: form,
    signal: AbortSignal.timeout(120_000),
  })
  const uploadText = await uploadRes.text()
  let uploaded = null
  try {
    uploaded = JSON.parse(uploadText)
  } catch {
    // 保留原文
  }
  if (!uploadRes.ok || !uploaded?.id) {
    return {
      status: uploadRes.status,
      ms: 0,
      message: uploaded?.error?.message ?? uploadText.slice(0, 200),
      usage: null,
    }
  }
  try {
    return await call(
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'document', source: { type: 'file', file_id: uploaded.id } }],
          },
        ],
      },
      { 'anthropic-beta': 'files-api-2025-04-14' }
    )
  } finally {
    await fetch(`${API_BASE}/anthropic/v1/files/${encodeURIComponent(uploaded.id)}`, {
      method: 'DELETE',
      headers: {
        'x-api-key': KEY,
        'anthropic-beta': 'files-api-2025-04-14',
      },
    }).catch(() => undefined)
  }
}

/** 流式请求：只看握手是否被拒，读到第一个事件就断开 */
const callStream = async (body) => {
  const started = Date.now()
  const controller = new AbortController()
  try {
    const response = await fetch(`${API_BASE}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        system: SYSTEM,
        max_tokens: 16,
        thinking: { type: 'disabled' },
        stream: true,
        ...body,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const text = await response.text()
      let payload = null
      try {
        payload = JSON.parse(text)
      } catch {
        // 保留原文
      }
      return {
        status: response.status,
        ms: Date.now() - started,
        message: payload?.error?.message ?? text.slice(0, 200),
        usage: null,
        firstEvent: '',
      }
    }
    // 只读第一块，确认 SSE 真的开始下发
    const reader = response.body.getReader()
    const { value } = await reader.read()
    const firstEvent = new TextDecoder().decode(value ?? new Uint8Array()).slice(0, 120)
    controller.abort()
    return { status: response.status, ms: Date.now() - started, message: '', usage: null, firstEvent }
  } catch (error) {
    // abort 自己触发的不算失败
    if (error?.name === 'AbortError') {
      return { status: 200, ms: Date.now() - started, message: '', usage: null, firstEvent: '' }
    }
    throw error
  }
}

/** 独立的搜索接口，harness 的 deepseek-search-api 后端就是它 */
const callSearch = async (query) => {
  const started = Date.now()
  const response = await fetch(`${API_BASE}/v1/tools/search`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({ query, count: 3, need_content: false, ori_question: query }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    // 非 JSON 保留原文
  }
  const items =
    payload?.results ?? payload?.data?.results ?? payload?.web_pages ?? payload?.data?.web_pages ?? []
  return {
    status: response.status,
    ms: Date.now() - started,
    message: payload?.error?.message ?? (response.ok ? '' : text.slice(0, 200)),
    count: Array.isArray(items) ? items.length : null,
    sample: Array.isArray(items) ? (items[0]?.title ?? items[0]?.name ?? '') : '',
  }
}

/**
 * 客户端工具往返：模型发起 tool_use 后，把 tool_result 回传能否继续生成正文。
 * 这是完整工具循环的最后一环——前面只验证了「声明工具不会被拦」。
 */
const callToolRoundTrip = async () => {
  const ask = '你必须调用 web_search 工具检索“DeepSeek 最新模型”，不要直接回答。'
  const first = await call({ messages: [{ role: 'user', content: ask }], tools: [CLIENT_TOOL] })
  const blocks = Array.isArray(first.payload?.content) ? first.payload.content : []
  const toolUse = blocks.find((block) => block?.type === 'tool_use')
  if (first.status !== 200 || !toolUse) {
    return { status: first.status, reason: first.message || '模型没有发起 tool_use', toolName: '' }
  }
  const second = await call({
    messages: [
      { role: 'user', content: ask },
      { role: 'assistant', content: blocks },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: '检索结果：DeepSeek 于 2026 年发布 V4.1 系列模型，上下文 1M token。',
          },
        ],
      },
    ],
    tools: [CLIENT_TOOL],
    max_tokens: 64,
  })
  const text = (second.payload?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('')
  return { status: second.status, reason: second.message, toolName: toolUse.name, text }
}

const describe = (result) => {
  const usage = result.usage
    ? ` · in=${result.usage.input_tokens ?? '?'} cache=${result.usage.cache_read_input_tokens ?? 0} total=${totalTokens(result.usage)} out=${result.usage.output_tokens ?? '?'}`
    : ''
  const message = result.message ? ` · ${result.message.replace(/\s+/g, ' ').slice(0, 150)}` : ''
  return `${result.status} ${result.ms}ms${usage}${message}`
}

const CASES = [
  {
    key: 'client_tool',
    title: '客户端工具（非流式）',
    build: () => ({
      messages: [{ role: 'user', content: longText }],
      tools: [CLIENT_TOOL],
    }),
  },
  {
    key: 'stream',
    title: '流式（无任何工具）',
    stream: true,
    build: () => ({ messages: [{ role: 'user', content: longText }] }),
  },
  {
    key: 'thinking',
    title: '深度思考（无工具、无 safety_check）',
    build: () => ({
      messages: [{ role: 'user', content: longText }],
      thinking: { type: 'enabled' },
    }),
  },
  {
    key: 'title',
    title: '会话标题（仅 title: { enabled: true }，无工具、无 safety_check）',
    build: () => ({
      messages: [{ role: 'user', content: longText }],
      title: { enabled: true },
    }),
  },
  {
    key: 'document_file',
    title: '纯 document(file_id)（无工具、无 safety_check、无 title）',
    custom: callDocumentFile,
    build: () => ({ messages: [{ role: 'user', content: '你好' }] }),
  },
  {
    key: 'harness_shape',
    title: 'harness 形态（客户端工具 + 流式）',
    stream: true,
    build: () => ({
      messages: [{ role: 'user', content: longText }],
      tools: [CLIENT_TOOL],
    }),
  },
]

/** 只跑一组：ONLY=thinking node scripts/test-harness-route.mjs */
const ONLY = (process.env.ONLY ?? '').trim()
const CASES_TO_RUN = ONLY ? CASES.filter((item) => item.key === ONLY) : CASES

if (DRY_RUN) {
  console.log(`DRY_RUN · model=${MODEL} · 长文本 ${longText.length.toLocaleString('en-US')} 字符`)
  console.log(`来源：${existsSync(LONG_FILE) ? LONG_FILE : '(生成)'}`)
  for (const item of CASES_TO_RUN) {
    const body = item.build()
    console.log(`- ${item.key}: stream=${Boolean(item.stream)} tools=${body.tools?.length ?? 0}`)
  }
  process.exit(0)
}

if (!KEY) {
  console.error('缺少 DEEPSEEK_API_KEY')
  process.exit(1)
}

console.log(`接口: ${API_BASE}/anthropic/v1/messages`)
console.log(`模型: ${MODEL} · 长文本: ${longText.length.toLocaleString('en-US')} 字符`)
console.log(`来源: ${existsSync(LONG_FILE) ? LONG_FILE : '(脚本生成)'}`)
console.log(`key: ${maskKey(KEY)}\n`)

const results = []
for (const item of CASES_TO_RUN) {
  console.log(`[${item.key}] ${item.title}`)
  if (item.custom) {
    const long = await item.custom()
    console.log(`  长请求: ${describe(long)}`)
    const verdict =
      long.status >= 400 ? (isTooLong(long.message) ? 'blocked' : 'error') : 'passed'
    console.log(
      `  判定: ${verdict === 'blocked' ? '❌ 撞墙' : verdict === 'error' ? `⚠️ ${long.status}` : '✅ 通过'}\n`
    )
    results.push({ ...item, short: null, long, verdict })
    continue
  }
  // 短请求先确认字段合法，避免把字段错误当成撞墙
  const shortBody = item.build()
  shortBody.messages = [{ role: 'user', content: '你好' }]
  const short = item.stream ? await callStream(shortBody) : await call(shortBody)
  console.log(`  短请求: ${describe(short)}`)
  if (short.status >= 400 && !isTooLong(short.message)) {
    console.log('  字段本身未通过，跳过长请求\n')
    results.push({ ...item, short, long: null, verdict: 'invalid' })
    continue
  }
  const long = item.stream ? await callStream(item.build()) : await call(item.build())
  console.log(`  长请求: ${describe(long)}`)
  const verdict = long.status >= 400 && isTooLong(long.message) ? 'blocked' : 'passed'
  console.log(`  判定: ${verdict === 'blocked' ? '❌ 撞墙' : '✅ 通过'}\n`)
  results.push({ ...item, short, long, verdict })
}

const search = ONLY
  ? { status: 0, ms: 0, count: null, sample: '', message: 'ONLY 模式跳过' }
  : await callSearch('DeepSeek API 文档')
if (!ONLY) {
  console.log('[search_api] POST /v1/tools/search')
  console.log(`  ${search.status} ${search.ms}ms · 结果 ${search.count ?? '?'} 条 · ${search.sample}`)
  console.log(`  ${search.message || '（无报错）'}\n`)
}

const roundTrip = ONLY
  ? { status: 0, toolName: '', reason: 'ONLY 模式跳过' }
  : await callToolRoundTrip()
if (!ONLY) {
  console.log('[tool_roundtrip] 客户端工具往返（tool_use → tool_result）')
  if (roundTrip.toolName) {
    console.log(`  模型发起: ${roundTrip.toolName}`)
    console.log(
      `  回传结果: ${roundTrip.status} · ${roundTrip.text ? roundTrip.text.replace(/\s+/g, ' ').slice(0, 90) : roundTrip.reason || '没有正文'}`
    )
  } else {
    console.log(`  未发起 tool_use: ${roundTrip.status} · ${roundTrip.reason}`)
  }
  console.log('')
}

const pick = (name) => results.find((item) => item.key === name)
const clientTool = pick('client_tool')
const streamOnly = pick('stream')
const harnessShape = pick('harness_shape')

console.log('===== 结论 =====')
const clientBlocked = clientTool?.verdict === 'blocked' || harnessShape?.verdict === 'blocked'
const clientPassed = clientTool?.verdict === 'passed' && harnessShape?.verdict === 'passed'
if (clientBlocked) {
  console.log('客户端工具：❌ 也触发 32K —— 完整客户端工具循环走不通，只能做预取式')
} else if (clientPassed) {
  console.log('客户端工具：✅ 不触发 32K —— 可以照 harness 做完整工具循环')
} else {
  console.log('客户端工具：⚠️ 数据不足（有分组字段未通过），看上面明细')
}
if (streamOnly?.verdict === 'blocked') {
  console.log('流式：❌ 单独触发 32K —— 应用侧必须改非流式或换通道')
} else if (streamOnly?.verdict === 'passed') {
  console.log('流式：✅ 不触发')
}
if (search.status !== 0) {
  if (search.status === 200) {
    console.log(`搜索 API：✅ 可用（返回 ${search.count ?? '?'} 条）—— 预取式搜索可行`)
  } else if (search.status === 404) {
    console.log('搜索 API：❌ 404 不存在 —— 预取式要另找数据源')
  } else {
    console.log(`搜索 API：⚠️ ${search.status} ${search.message.slice(0, 100)}`)
  }
}
const thinkingOnly = pick('thinking')
if (thinkingOnly) {
  console.log(
    thinkingOnly.verdict === 'blocked'
      ? '深度思考：❌ 开启后就触发 32K —— 这才是应用里失败的原因'
      : '深度思考：✅ 不触发'
  )
}
const titleOnly = pick('title')
if (titleOnly) {
  console.log(
    titleOnly.verdict === 'blocked'
      ? '会话标题：❌ title.enabled=true 会触发 32K —— 长上下文模式必须省略 title'
      : '会话标题：✅ 不触发'
  )
}
const docOnly = pick('document_file')
if (docOnly) {
  console.log(
    docOnly.verdict === 'blocked'
      ? '纯 document(file_id)：❌ 单独触发 32K —— 纯文本必须本地内联'
      : docOnly.verdict === 'passed'
        ? '纯 document(file_id)：✅ 不触发（之前撞墙是其他扩展字段导致）'
        : `纯 document(file_id)：⚠️ 请求异常 (${docOnly.long?.status ?? '?'})`
  )
}
if (roundTrip.status !== 0) {
  if (roundTrip.toolName && roundTrip.status === 200) {
    console.log('工具往返：✅ 通过（tool_use → tool_result → 正文）—— 完整客户端工具循环可做')
  } else if (roundTrip.toolName) {
    console.log(`工具往返：❌ 回传 tool_result 失败 —— 只能做旁路预取（${roundTrip.status}）`)
  } else {
    console.log('工具往返：⚠️ 模型没发起调用，无法判定，可换个更明确的提示词再试')
  }
}

const maxTotal = Math.max(0, ...results.map((item) => totalTokens(item.long?.usage)))
console.log(`本次最大一次上下文：${maxTotal.toLocaleString('en-US')} tokens`)
if (maxTotal <= 32_768 && !clientBlocked) {
  console.log('⚠️ 最大上下文没超过 32768，结论不算数，请用 LONG_CHARS=120000 重跑')
}
