import fs from 'node:fs'

/** Shared helpers: chunking, sleep, HTTP, iLink headers. */

export function chunkText(text: string, maxLen = 3500): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen)
    if (cut < maxLen * 0.5) cut = rest.lastIndexOf(' ', maxLen)
    if (cut < maxLen * 0.5) cut = maxLen
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).trimStart()
  }
  if (rest) out.push(rest)
  return out
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '\n…（内容过长已截断）'
}

/** random uint32, decimal string, base64 — the iLink `X-WECHAT-UIN` header. */
export function randomUin(): string {
  const n = Math.floor(Math.random() * 0xffffffff)
  return Buffer.from(String(n), 'utf8').toString('base64')
}

export interface JsonResponse {
  ok: boolean
  status: number
  data: any
  error?: string
}

/** Minimal fetch wrapper with timeout and JSON parsing. */
export async function fetchJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<any> {
  const { method = 'GET', headers = {}, body, timeoutMs = 30000 } = options
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let data: any = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = text }
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`)
    ;(err as any).status = res.status
    ;(err as any).data = data
    throw err
  }
  return data
}

/** iLink 请求头：Bearer + AuthorizationType + 每次随机的 X-WECHAT-UIN。 */
export function ilinkHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomUin(),
  }
}

export function formatError(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/** File-backed diagnostics log (crash-safe): survives process exits. */
let logFilePath = ''
export function setLogFile(p: string): void { logFilePath = p }
export function fileLog(tag: string, ...args: any[]): void {
  if (!logFilePath) return
  try {
    const parts = args.map((a) => a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))
    const line = `[${new Date().toISOString()}] ${tag} ${parts.join(' ')}
`
    fs.appendFileSync(logFilePath, line)
  } catch { /* never throw from diagnostics */ }
}
