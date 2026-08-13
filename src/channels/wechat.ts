/**
 * WeChat ClawBot (微信 iLink Bot API) channel.
 *
 * 接收：`/ilink/bot/getupdates` 长轮询（35s hold），游标 `get_updates_buf` 续传。
 * 发送：`/ilink/bot/sendmessage`，必须携带入站消息的 `context_token`。
 * 限速：官方约 7 条 / 5 分钟（服务端限制），本地排队 + 退避。
 */
import { randomBytes } from 'node:crypto'
import type { WechatConfig } from '../config.js'
import type { MessageRunner } from '../dsh.js'
import { chunkText, fetchJson, fileLog, formatError, ilinkHeaders, sleep } from '../util.js'

type Logger = { info: (f: string, ...a: any[]) => void; warn: (f: string, ...a: any[]) => void; error: (f: string, ...a: any[]) => void }

interface WeixinMessage {
  from_user_id?: string
  to_user_id?: string
  message_type?: number
  message_state?: number
  context_token?: string
  client_msg_id?: string
  server_msg_id?: string
  create_time_ms?: number
  item_list?: { type?: number; text_item?: { text?: string } }[]
}

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000
const RATE_LIMIT_MAX = 6 // 留 1 条余量

export class WeChatChannel {
  private running = false
  private buf = ''
  private seen = new Set<string>()
  private sendTimes: number[] = []

  constructor(private cfg: WechatConfig, private runner: MessageRunner, private log: Logger) {}

  async start(): Promise<void> {
    if (!this.cfg.token) throw new Error('微信通道需要 token（openclaw 微信登录后获取）')
    this.running = true
    void this.pollLoop()
    this.log.info('微信通道已启动（baseUrl=%s）', this.cfg.baseUrl)
  }

  async stop(): Promise<void> {
    this.running = false
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const res = await this.getUpdates()
        const msgs = res && Array.isArray(res.msgs) ? res.msgs : []
        for (const msg of msgs) {
          await this.handleMessage(msg)
        }
        if (res && typeof res.get_updates_buf === 'string') this.buf = res.get_updates_buf
        // 服务端正常会 hold 住连接；空批次时稍作停顿，避免热循环
        if (msgs.length === 0) await sleep(1000)
      } catch (e) {
        const msg = formatError(e)
        this.log.warn('微信轮询错误: %s', msg)
        if (/ret=-14|会话过期|token/i.test(msg)) {
          this.log.error('微信会话可能已过期，请重新登录 openclaw 微信渠道')
        }
        await sleep(3000)
      }
    }
  }

  private async getUpdates(): Promise<any> {
    const data = await fetchJson(`${this.cfg.baseUrl}/ilink/bot/getupdates`, {
      method: 'POST',
      headers: ilinkHeaders(this.cfg.token),
      body: JSON.stringify({ get_updates_buf: this.buf, base_info: { channel_version: '1.0.2' } }),
      timeoutMs: this.cfg.pollTimeoutMs + 10000,
    })
    this.checkError(data, 'getupdates')
    return data
  }

  /**
   * iLink 成功响应可能没有 `ret` 字段（直接返回 msgs / get_updates_buf），
   * 失败响应带 `errcode`（如 -14 session timeout）。两者都容忍。
   */
  private checkError(data: any, op: string): void {
    if (data == null) throw new Error(`${op}: empty response`)
    if (data.errcode !== undefined && data.errcode !== 0) {
      throw new Error(`${op} errcode=${data.errcode} ${data.errmsg ?? ''}`)
    }
    if (data.ret !== undefined && data.ret !== 0) {
      throw new Error(`${op} ret=${data.ret}`)
    }
  }

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    if (msg.message_type !== 1) return // 只处理用户消息
    const from = msg.from_user_id
    const text = msg.item_list?.[0]?.text_item?.text?.trim()
    if (!from || !text) return
    if (this.cfg.allowUsers.length > 0 && !this.cfg.allowUsers.includes(from)) {
      this.log.info('微信: 忽略未授权发送者 %s', from)
      return
    }
    const id = msg.client_msg_id ?? msg.server_msg_id ?? `${from}:${msg.create_time_ms}`
    if (this.seen.has(id)) return
    this.seen.add(id)
    if (this.seen.size > 2000) this.seen.clear()
    fileLog('inbound', 'from=' + from + ' ctxToken=' + (msg.context_token ? msg.context_token.slice(0, 12) + '…' : '(EMPTY!)') + ' text=' + text.slice(0, 40))

    try {
      const reply = await this.runner.ask(`wechat:${from}`, text)
      for (const chunk of chunkText(reply)) {
        await this.rateLimitedSend(from, msg.context_token ?? '', chunk)
      }
    } catch (e) {
      this.log.warn('微信回答失败: %s', formatError(e))
      fileLog('wechat-answer-fail', 'from=' + from + ' err=' + formatError(e))
    }
  }

  private async rateLimitedSend(toUserId: string, contextToken: string, text: string): Promise<void> {
    const now = Date.now()
    this.sendTimes = this.sendTimes.filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
    while (this.sendTimes.length >= RATE_LIMIT_MAX) {
      const wait = RATE_LIMIT_WINDOW_MS - (now - this.sendTimes[0])
      this.log.info('微信限速，等待 %d ms', wait)
      await sleep(Math.min(wait, 30000))
      this.sendTimes = this.sendTimes.filter((t) => Date.now() - t < RATE_LIMIT_WINDOW_MS)
    }
    await this.sendMessage(toUserId, contextToken, text)
    this.sendTimes.push(Date.now())
  }

  private async sendMessage(toUserId: string, contextToken: string, text: string): Promise<void> {
    // 官方 SDK 必填字段：缺 client_id / from_user_id / base_info 会导致
    // HTTP 200 但消息被静默丢弃（投递失败无报错）。
    const data = await fetchJson(`${this.cfg.baseUrl}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: ilinkHeaders(this.cfg.token),
      body: JSON.stringify({
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: 'openclaw-weixin-' + randomBytes(8).toString('hex'),
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text } }],
        },
        base_info: { channel_version: '1.0.2' },
      }),
      timeoutMs: 30000,
    })
    this.checkError(data, 'sendmessage')
    fileLog('send', 'ok to=' + toUserId + ' ctxToken=' + (contextToken ? contextToken.slice(0, 12) + '…' : '(EMPTY!)') + ' len=' + text.length + ' resp=' + JSON.stringify(data).slice(0, 300))
  }
}
