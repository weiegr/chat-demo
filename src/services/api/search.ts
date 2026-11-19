import { translate } from '../../i18n/index.js'
import { API_ORIGIN, request } from './client.js'

/**
 * 旁路检索：直接调用搜索接口，不经过模型、不声明服务端工具。
 * 用途是让「智能搜索」不再把主请求带进扩展模式（单条消息 32768 token 的上限）。
 * 接口与参数取自官方 harness 的 deepseek-search-api 后端。
 */

export type WebSource = {
  url: string
  title: string
  /** 展示用的短摘要 */
  snippet: string
  /** 更完整的模型可读摘要，可能缺省 */
  summary?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const toSource = (value: unknown): WebSource | null => {
  if (!isRecord(value) || typeof value.url !== 'string' || value.url === '') {
    return null
  }
  if (typeof value.title !== 'string' || typeof value.snippet !== 'string') {
    return null
  }
  return {
    url: value.url,
    title: value.title,
    snippet: value.snippet,
    ...(typeof value.summary === 'string' && value.summary !== ''
      ? { summary: value.summary }
      : {}),
  }
}

/** 查询词取本轮提问开头：长文档的开头通常是标题或摘要，足以召回相关结果 */
const QUERY_MAX_CHARS = 120

export const toSearchQuery = (text: string) =>
  text.replace(/\s+/g, ' ').trim().slice(0, QUERY_MAX_CHARS)

/** POST /v1/tools/search；鉴权用 Bearer，与 Anthropic 兼容接口的 x-api-key 不同 */
export const searchWeb = async (
  apiKey: string,
  query: string,
  signal: AbortSignal,
  count = 5
): Promise<WebSource[]> => {
  const response = await request(`${API_ORIGIN}/v1/tools/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, count, need_content: false, ori_question: query }),
    signal,
  })
  const body: unknown = await response.json().catch(() => null)
  if (!isRecord(body) || !Array.isArray(body.results)) {
    return []
  }
  return body.results.flatMap((item) => toSource(item) ?? [])
}

/**
 * 拼成一段模型可读的上下文，作为本轮用户消息的第一个文本块。
 * 注明来源与「非用户输入」，避免模型把检索结果当成用户的原始需求。
 */
export const formatSearchContext = (sources: WebSource[]): string => {
  const items = sources.map((source, index) => {
    const summary = source.summary ?? source.snippet
    const head = `[${index + 1}] ${source.title || source.url}`
    return summary ? `${head}\n${source.url}\n${summary}` : `${head}\n${source.url}`
  })
  return `${translate('searchContextPreamble')}\n\n${items.join('\n\n')}`
}
