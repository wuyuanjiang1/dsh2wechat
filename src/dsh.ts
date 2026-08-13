/**
 * AgentRunner: answers chat messages through DSH's own agent runtime.
 *
 * Each conversation gets ONE dedicated persistent Agent (a separate session
 * in the harness's session store — never the GUI conversation). The agent's
 * durable log is its own memory, so follow-ups keep full context across
 * messages and restarts.
 *
 * API contract (dsh-agent):
 *  - `ctx.agents.resume({ resumeSessionId })` — restore a persisted session;
 *  - `ctx.agents.create({ sessionId, meta: { cwd } })` — first contact;
 *  - `agent.followup(userMessage)` queues one ordinary turn and wakes the loop;
 *  - `agent.whenIdle()` resolves when the whole-agent activity settles;
 *  - the final answer is the last `assistant/message` session event of the new turn.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { fileLog, formatError } from './util.js'

type Logger = { info: (f: string, ...a: any[]) => void; warn: (f: string, ...a: any[]) => void; error: (f: string, ...a: any[]) => void }

export interface AgentRunnerConfig {
  /** Working directory of the dedicated agents. */
  cwd: string
  /** Abort a turn after this many milliseconds. */
  timeoutMs: number
  /** Provider route for created agents (defaults to ctx.agentDefaultModel). */
  provider?: string
  /** Model id for created agents (defaults to ctx.agentDefaultModel). */
  model?: string
}

function agentOptions(cfg: AgentRunnerConfig): { provider?: string; model?: string } {
  const opts: { provider?: string; model?: string } = {}
  if (cfg.provider) opts.provider = cfg.provider
  if (cfg.model) opts.model = cfg.model
  return opts
}

/** Minimal runner contract used by the channels. */
export interface MessageRunner {
  ask(key: string, text: string): Promise<string>
}

/**
 * 进程级共享的 Agent 句柄表：插件行热重载（apply 再次执行）后，新实例
 * 直接复用旧实例仍在内存中的 live Agent，避免同 id 会话冲突。
 */
const liveAgents = new Map<string, AgentHandle>()

export class AgentRunner implements MessageRunner {
  private handles = new Map<string, AgentHandle>()
  private inflight = new Map<string, Promise<string>>()

  constructor(private cfg: AgentRunnerConfig, private ctx: Context, private log: Logger) {}

  /** Serialize one conversation: a single agent turn in flight at a time. */
  ask(key: string, text: string): Promise<string> {
    const prev = this.inflight.get(key) ?? Promise.resolve('')
    const run = prev.then(() => this.runOnce(key, text))
    this.inflight.set(key, run)
    // 注意：run 失败时 finally 链会再产生一个 rejection，必须显式吞掉，
    // 否则 Node（默认 --unhandled-rejections=throw）会让整个进程退出。
    void run.then(
      () => { if (this.inflight.get(key) === run) this.inflight.delete(key) },
      () => { if (this.inflight.get(key) === run) this.inflight.delete(key) },
    )
    return run
  }

  private async runOnce(key: string, text: string): Promise<string> {
    const handle = await this.getOrCreate(key)
    const agent = handle.agent
    const startTurn = this.lastTurn(agent.session.events)
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    agent.followup(message)
    fileLog('followup', 'sent to session=' + agent.id + ' status=' + agent.status + ' text=' + text.slice(0, 80))

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          agent.cancel({ kind: 'hook', reason: 'dshplug timeout' })
        } catch (e) {
          this.log.warn('取消 agent 失败: %s', formatError(e))
        }
        fileLog('timeout', 'turn aborted after ' + this.cfg.timeoutMs + 'ms')
        reject(new Error(`agent 回答超时（${this.cfg.timeoutMs}ms），已取消该轮`))
      }, this.cfg.timeoutMs)
    })
    try {
      fileLog('whenIdle', 'waiting, status=' + agent.status + ' events=' + agent.session.events.length)
      await Promise.race([agent.whenIdle(), timeout])
      fileLog('whenIdle', 'settled, status=' + agent.status + ' events=' + agent.session.events.length)
    } finally {
      if (timer) clearTimeout(timer)
    }
    try {
      const reply = this.extractReply(agent.session.events, startTurn)
      fileLog('reply', 'len=' + reply.length + ' head=' + reply.slice(0, 60).replace(/\n/g, ' '))
      return reply
    } catch (e) {
      fileLog('extract-fail', 'afterTurn=' + startTurn + ' err=' + formatError(e))
      throw e
    }
  }

  private async getOrCreate(key: string): Promise<AgentHandle> {
    // 跨实例复用：热重载/重复 apply 后旧 Agent 仍 live，直接续用
    const shared = liveAgents.get(key)
    if (shared) {
      this.handles.set(key, shared)
      return shared
    }
    const existing = this.handles.get(key)
    if (existing) return existing
    const baseId = this.sessionIdFor(key)

    // 1) 优先恢复既有会话
    try {
      const handle = await this.ctx.agents.resume({ resumeSessionId: SessionId(baseId), agentOptions: agentOptions(this.cfg) })
      this.log.info('恢复会话 %s', baseId)
      fileLog('resume', 'OK session=' + baseId)
      liveAgents.set(key, handle)
      this.handles.set(key, handle)
      return handle
    } catch (e) {
      fileLog('resume', 'FAIL session=' + baseId + ' err=' + formatError(e))
    }

    // 2) 创建（带自愈：冲突时清磁盘残留 → 尝试恢复磁盘日志 → 轮换 id）
    for (let attempt = 0; attempt < 3; attempt++) {
      const sid = SessionId(attempt === 0 ? baseId : baseId + '-' + attempt)
      if (attempt > 0) await this.purgeSession(String(sid))
      try {
        const handle = await this.createAgent(sid)
        liveAgents.set(key, handle)
        this.handles.set(key, handle)
        return handle
      } catch (e2) {
        const msg = formatError(e2)
        if (/already exists|while it is live|cannot prepare|collision|does not match/i.test(msg)) {
          await this.purgeSession(String(sid))
          // 磁盘可能已有该 id 的持久日志（上个进程/轮换遗留）→ 恢复而不是重建
          try {
            const handle = await this.ctx.agents.resume({ resumeSessionId: sid, agentOptions: agentOptions(this.cfg) })
            fileLog('heal', 'resumed after collision session=' + sid)
            liveAgents.set(key, handle)
            this.handles.set(key, handle)
            return handle
          } catch (e3) {
            fileLog('heal', 'rotate to ' + sid + ' after: ' + msg + ' | resume-fallback: ' + formatError(e3))
          }
        } else {
          throw e2
        }
      }
    }
    throw new Error('无法创建会话（' + baseId + '，多次自愈失败）')
  }

  private async createAgent(sessionId: SessionId): Promise<AgentHandle> {
    const cwdOk = this.cfg.cwd && fs.existsSync(this.cfg.cwd)
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: cwdOk ? { cwd: this.cfg.cwd } : undefined,
      agentOptions: agentOptions(this.cfg),
    })
    this.log.info('创建会话 %s%s', sessionId, cwdOk ? `（cwd=${this.cfg.cwd}）` : '')
    fileLog('create', 'OK session=' + sessionId)
    if (!cwdOk) this.log.warn('cwd 不存在: %s，会话未绑定工作目录', this.cfg.cwd)
    return handle
  }

  /** 删除本插件创建的 im-* 会话的持久化目录（自愈用）。 */
  private async purgeSession(sessionId: string): Promise<boolean> {
    try {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
      const root = path.join(home, 'sessions')
      const dirs = fs.readdirSync(root)
      for (const d of dirs) {
        const projectDir = path.join(root, d)
        if (!fs.statSync(projectDir).isDirectory()) continue
        const target = path.join(projectDir, sessionId)
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
          fs.rmSync(target, { recursive: true, force: true })
          fileLog('heal', 'purged ' + target)
          return true
        }
      }
      return false
    } catch (e) {
      fileLog('heal', 'purge failed err=' + formatError(e))
      return false
    }
  }

  /**
   * 插件卸载/热重载时调用。不 dispose 共享句柄：热重载后新 apply 实例
   * 会复用仍在内存中的 live Agent（避免同 id 冲突）；进程退出时由 DSH 清理。
   */
  async dispose(): Promise<void> {
    this.handles.clear()
  }

  /** Stable, filesystem-safe session id for one conversation key. */
  private sessionIdFor(key: string): string {
    const safe = key.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
    return `im-${safe || 'chat'}`
  }

  private lastTurn(events: readonly SessionEvent[]): number {
    let turn = -1
    for (const e of events) {
      if (e.type === 'turn/start' && e.data.turn > turn) turn = e.data.turn
    }
    return turn
  }

  private extractReply(events: readonly SessionEvent[], afterTurn: number): string {
    let reply = ''
    for (const e of events) {
      if (e.type !== 'assistant/message') continue
      if (afterTurn >= 0 && e.data.turn <= afterTurn) continue
      const text = extractText(e.data.message.content)
      if (text) reply = text
    }
    if (!reply) throw new Error('agent 本轮未产生回答文本')
    return reply
  }
}

function extractText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const b of blocks) {
    if (b.type === 'text' && b.text) parts.push(b.text)
  }
  return parts.join('\n').trim()
}
