/**
 * dshplug configuration: types, defaults, and normalization.
 *
 * The loader passes the row's `config` (from the bundle patch and any
 * profile-level overrides) as the plugin's second argument; values are
 * merged over these defaults.
 */
import os from 'node:os'

export interface DshConfig {
  /** Working directory of the dedicated agents (default: home). */
  cwd: string
  /** Abort an agent turn after this many milliseconds. */
  timeoutMs: number
  /** 可选：显式 provider 路由（缺省用 ctx.agentDefaultModel）。 */
  provider?: string
  /** 可选：显式 model id（缺省用 ctx.agentDefaultModel）。 */
  model?: string
}

export interface WechatConfig {
  enabled: boolean
  /** ClawBot Bearer token（`openclaw channels login --channel openclaw-weixin` 或 `wxclawbot accounts` 获取）。 */
  token: string
  /** 机器人账号 ID（形如 `xxx@im.bot`），仅用于日志。 */
  botId: string
  /** iLink 网关地址；扫码登录返回的 baseurl 优先。 */
  baseUrl: string
  /** 仅响应这些用户（`xxx@im.wechat`）；空数组 = 不限制。 */
  allowUsers: string[]
  /** getupdates 长轮询超时（服务端 hold 时间）。 */
  pollTimeoutMs: number
}

export interface ServerConfig {
  enabled: boolean
  /** 本地状态/健康检查 HTTP 端口。 */
  port: number
}

export interface Config {
  dsh: DshConfig
  wechat: WechatConfig
  server: ServerConfig
}

export const DEFAULT_CONFIG: Config = {
  dsh: {
    cwd: '',
    timeoutMs: 15 * 60 * 1000,
  },
  wechat: {
    enabled: false,
    token: '',
    botId: '',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    allowUsers: [],
    pollTimeoutMs: 35000,
  },
  server: {
    enabled: false,
    port: 3901,
  },
}

function merge<T>(target: T, source: unknown): T {
  if (source === undefined || source === null) return target
  if (typeof source !== 'object' || Array.isArray(source)) return source as T
  const out: any = { ...(target as any) }
  for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
    const cur = (target as any)?.[k]
    out[k] = cur !== undefined && typeof cur === 'object' && !Array.isArray(cur) && typeof v === 'object' && v !== null
      ? merge(cur, v)
      : v
  }
  return out as T
}

/** Deep-merge the loader config over defaults. */
export function normalizeConfig(input: Partial<Config> | undefined): Config {
  const cfg = merge(structuredClone(DEFAULT_CONFIG), input ?? {}) as Config
  if (!cfg.dsh.cwd) cfg.dsh.cwd = os.homedir()
  return cfg
}

export function channelState(cfg: Config) {
  return {
    wechat: cfg.wechat.enabled ? (cfg.wechat.token ? 'on' : 'on (missing token!)') : 'off',
    server: cfg.server.enabled ? 'on' : 'off',
  }
}
