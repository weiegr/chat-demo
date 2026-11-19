#!/usr/bin/env node
/**
 * 验证 32768 token 输入闸门由哪个请求特征触发（独立脚本，不改应用代码）。
 *
 * 用法（Git Bash / PowerShell 均可，Node 18+）：
 *   DEEPSEEK_API_KEY=sk-xxx node scripts/test-input-limit.mjs
 *
 * 可选环境变量：
 *   DEEPSEEK_MODEL   默认 deepseek-flash
 *   LONG_CHARS       长输入汉字数，默认 100000
 *   API_BASE         默认 https://api.deepseek.com
 *   DRY_RUN=1        只打印分组，不发请求
 *
 * 每组先发短请求确认字段合法，再发长请求；成功的请求会打印服务端统计的 input_tokens，
 * 用来确认这次长输入是否真的超过 32768。
 */

const API_BASE = (process.env.API_BASE ?? 'https://api.deepseek.com').replace(/\/$/, '')
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'
const LONG_CHARS = Number(process.env.LONG_CHARS ?? 100_000)
const DRY_RUN = process.env.DRY_RUN === '1'
const KEY = process.env.DEEPSEEK_API_KEY ?? ''

const SYSTEM = '该助手为DeepSeek，由深度求索公司创造。'
const UNIT =
  '这是一段用于测试单次输入长度上限的占位文本，没有实际含义，只用来把请求的上下文推到阈值以上。'
const longText = UNIT.repeat(Math.ceil(LONG_CHARS / UNIT.length)).slice(0, LONG_CHARS)
/** 服务端只认这种语言写法；本项目 zh 文案就是“中文” */
const REMINDER = { role: 'latest_reminder', content: '2026-11-19,星期四,北京,Web,中文' }
const READ_URL = { type: 'deepseek_read_url', name: 'deepseek_read_url' }

const REPLY = { role: 'assistant', content: [{ type: 'text', text: '收到' }] }

/** 每组只在基础请求上改变一项，便于定位 */
const VARIANTS = [
  {
    name: 'plain',
    build: (text) => ({ messages: [{ role: 'user', content: text }] }),
  },
  {
    name: '+latest_reminder',
    build: (text) => ({ messages: [REMINDER, { role: 'user', content: text }] }),
  },
  {
    name: '+safety_check',
    build: (text) => ({
      messages: [{ role: 'user', content: text }],
      safety_check: { level: 'high' },
    }),
  },
  {
    name: '+safety_check(low)',
    build: (text) => ({
      messages: [{ role: 'user', content: text }],
      safety_check: { level: 'low' },
    }),
  },
  {
    name: '+tools(read_url)',
    build: (text) => ({
      messages: [{ role: 'user', content: text }],
      tools: [READ_URL],
    }),
  },
  {
    name: 'multi-turn',
    build: (text) => {
      const half = Math.ceil(text.length / 2)
      return {
        messages: [
          { role: 'user', content: text.slice(0, half) },
          REPLY,
          { role: 'user', content: text.slice(half) },
        ],
      }
    },
  },
  {
    name: 'multi-turn+all',
    build: (text) => {
      const half = Math.ceil(text.length / 2)
      return {
        messages: [
          REMINDER,
          { role: 'user', content: text.slice(0, half) },
          REPLY,
          { role: 'user', content: text.slice(half) },
        ],
        safety_check: { level: 'high' },
        tools: [READ_URL],
      }
    },
  },
]

const maskKey = (key) => (key ? `${key.slice(0, 3)}…${key.slice(-4)}` : '(未设置)')

const call = async (body) => {
  const started = Date.now()
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
  }
}

const isTooLong = (message) => /user input too long/i.test(message ?? '')
/** 总输入 = 未命中缓存 + 命中缓存 + 缓存创建；只看 input_tokens 会被缓存误导 */
const totalTokens = (usage) =>
  (usage?.input_tokens ?? 0) +
  (usage?.cache_read_input_tokens ?? 0) +
  (usage?.cache_creation_input_tokens ?? 0)
const describe = (result) => {
  const usage = result.usage
    ? ` · in=${result.usage.input_tokens ?? '?'} cache=${result.usage.cache_read_input_tokens ?? 0} total=${totalTokens(result.usage)} out=${result.usage.output_tokens ?? '?'}`
    : ''
  const message = result.message ? ` · ${result.message.replace(/\s+/g, ' ').slice(0, 160)}` : ''
  return `${result.status} ${result.ms}ms${usage}${message}`
}

if (DRY_RUN) {
  console.log(`DRY_RUN · model=${MODEL} · longChars=${LONG_CHARS.toLocaleString('en-US')}`)
  for (const variant of VARIANTS) {
    const body = variant.build('…')
    console.log(
      `  ${variant.name.padEnd(18)} ${body.messages.length} 条消息 · ${JSON.stringify(body).slice(0, 120)}`
    )
  }
  process.exit(0)
}

if (!KEY) {
  console.error('缺少 DEEPSEEK_API_KEY。示例：')
  console.error('  DEEPSEEK_API_KEY=sk-xxx node scripts/test-input-limit.mjs')
  process.exit(1)
}

console.log(`接口: ${API_BASE}/anthropic/v1/messages`)
console.log(`模型: ${MODEL} · 长输入: ${LONG_CHARS.toLocaleString('en-US')} 字 · key: ${maskKey(KEY)}`)
console.log('')

const results = []
for (const variant of VARIANTS) {
  console.log(`[${variant.name}]`)
  let small
  try {
    small = await call(variant.build('只回复“收到”两个字。'))
  } catch (error) {
    console.log(`  短请求失败: ${error instanceof Error ? error.message : String(error)}`)
    results.push({ name: variant.name, small: null, long: null })
    continue
  }
  console.log(`  短请求: ${describe(small)}`)
  if (small.status !== 200) {
    console.log('  字段本身未通过，跳过长请求')
    results.push({ name: variant.name, small, long: null })
    console.log('')
    continue
  }
  let long
  try {
    long = await call(variant.build(longText))
  } catch (error) {
    console.log(`  长请求失败: ${error instanceof Error ? error.message : String(error)}`)
    results.push({ name: variant.name, small, long: null })
    continue
  }
  console.log(`  长请求: ${describe(long)}`)
  results.push({ name: variant.name, small, long })
  console.log('')
}

console.log('===== 汇总 =====')
for (const { name, small, long } of results) {
  const verdict = !small
    ? '异常'
    : small.status !== 200
      ? `短请求 ${small.status}`
      : !long
        ? '长请求异常'
        : isTooLong(long.message)
          ? '❌ 撞墙'
          : long.status === 200
            ? `✅ 通过（total=${totalTokens(long.usage)}）`
            : `⚠️ ${long.status}`
  console.log(`  ${name.padEnd(18)} ${verdict}`)
}

const tooLongResults = results.filter((item) => isTooLong(item.long?.message))
const plain = results.find((item) => item.name === 'plain')
const maxInput = Math.max(0, ...results.map((item) => totalTokens(item.long?.usage)))

console.log('')
if (tooLongResults.length === 0) {
  if (maxInput > 0 && maxInput < 32_768) {
    console.log(`最大一次只送到 ${maxInput} token，还没到 32768，结论无效。`)
    console.log('把 LONG_CHARS 调大再跑，例如 LONG_CHARS=200000。')
  } else {
    console.log('没有任何一组撞墙：这个 key 可能不在灰度内，或闸门不在输入 token 总数上。')
  }
} else if (isTooLong(plain?.long?.message)) {
  console.log('连 plain 都撞墙：闸门在账号 / 模型 / 接口层，和具体字段无关。')
} else {
  console.log(`只有这些组撞墙：${tooLongResults.map((item) => item.name).join('、')}`)
  const failed = new Set(tooLongResults.map((item) => item.name))
  if (failed.has('+safety_check') || failed.has('+tools(read_url)')) {
    console.log('safety_check / 服务端工具会让请求进入扩展模式，32K 闸门只在这些组出现。')
    const low = results.find((item) => item.name === '+safety_check(low)')
    if (low?.long?.status === 200) {
      console.log('+safety_check(low) 能过：把 high 换成 low 可以绕开这道闸门（只剩默认检查）。')
    }
  }
  if (failed.has('multi-turn') && !failed.has('plain')) {
    console.log('多轮组撞墙而单条不撞：闸门看的是整段会话上下文，不只是当前这条消息。')
  } else if (failed.has('+latest_reminder') && !failed.has('plain')) {
    console.log('单条 plain 能过、+latest_reminder 撞墙：latest_reminder 就是触发项。')
  }
}
