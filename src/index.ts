/**
 * dshplug — DeepSeek Harness 消息桥（IM Bridge）。
 *
 * 让 DeepSeek Harness 通过微信 ClawBot（iLink）接收用户消息，
 * 用专属 Agent 会话（ctx.agents）回答，再回发。
 */
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// 激活 dsh-agent-default-model 对 Context 的类型扩展（ctx.agentDefaultModel）
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { normalizeConfig, channelState, type Config } from './config.js'
import { setLogFile, fileLog } from './util.js'
import { AgentRunner } from './dsh.js'
import { WeChatChannel } from './channels/wechat.js'
import { StatusServer } from './server.js'

export const name = 'dshplug'
/** 需要的服务：AgentRegistry（ctx.agents）——没有 inject 声明访问会被拒绝 */
export const inject = ['agents', 'agentDefaultModel']
export type { Config } from './config.js'

export function apply(ctx: Context, config: Config = {} as Config): () => Promise<void> {
  const logger = ctx.logger('dshplug')

  // ── 崩溃诊断：文件日志 + 进程级错误钩子（止血并留证）──
  // 注册后 Node 不再因 unhandledRejection/uncaughtException 默认退出进程，
  // 堆栈会写入 $DSH_HOME/dshplug.log 供排查。
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  setLogFile(path.join(home, 'dshplug.log'))
  const onUnhandled = (reason: unknown) => {
    fileLog('unhandledRejection', reason)
    logger.error('未处理的 Promise 拒绝: %s', reason instanceof Error ? reason.message : String(reason))
  }
  const onUncaught = (err: Error) => {
    fileLog('uncaughtException', err)
    logger.error('未捕获异常: %s', err.stack ?? err.message)
  }
  process.on('unhandledRejection', onUnhandled)
  process.on('uncaughtException', onUncaught)

  const cfg = normalizeConfig(config)
  fileLog('apply', 'dshplug 行加载，channels=' + JSON.stringify(channelState(cfg)))
  // 默认模型：配置显式值优先，否则读 ctx.agentDefaultModel（persona {{model}} 依赖）
  let provider = cfg.dsh.provider
  let model = cfg.dsh.model
  try {
    const sel = ctx.agentDefaultModel.currentSelection()
    provider = provider ?? sel.provider
    model = model ?? sel.model
    fileLog('model', 'provider=' + provider + ' model=' + model)
  } catch (e) {
    logger.warn('读取默认模型失败: %s', e instanceof Error ? e.message : String(e))
  }
  const runner = new AgentRunner({ ...cfg.dsh, provider, model }, ctx, logger)

  const wechat = new WeChatChannel(cfg.wechat, runner, logger)
  const server = new StatusServer(cfg.server, () => channelState(cfg), logger)

  if (cfg.wechat.enabled) {
    void wechat.start().catch((e) => logger.error('微信通道启动失败: %s', e instanceof Error ? e.message : String(e)))
  }
  if (cfg.server.enabled) {
    void server.start().catch((e) => logger.error('状态服务启动失败: %s', e instanceof Error ? e.message : String(e)))
  }

  logger.info('dshplug 已启动：%s', JSON.stringify(channelState(cfg)))

  return async () => {
    process.removeListener('unhandledRejection', onUnhandled)
    process.removeListener('uncaughtException', onUncaught)
    await Promise.allSettled([wechat.stop(), server.stop(), runner.dispose()])
    logger.info('dshplug 已停止')
    fileLog('dispose', 'dshplug 行已停止')
  }
}
