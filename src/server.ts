/** Optional local status/health HTTP endpoint. */
import http from 'node:http'
import type { ServerConfig } from './config.js'

type Logger = { info: (f: string, ...a: any[]) => void; warn: (f: string, ...a: any[]) => void }

export class StatusServer {
  private server?: http.Server

  constructor(private cfg: ServerConfig, private state: () => any, private log: Logger) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (req.url === '/health' || req.url === '/') {
        const body = JSON.stringify({ ok: true, uptime: process.uptime(), channels: this.state() }, null, 2)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(body)
        return
      }
      res.writeHead(404).end('not found')
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.cfg.port, '127.0.0.1', () => resolve())
    })
    this.log.info('状态服务: http://127.0.0.1:%d/health', this.cfg.port)
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
  }
}
