#!/usr/bin/env node
/**
 * 微信 ClawBot 扫码登录工具（零外部依赖，不需要任何浏览器桥）。
 *
 * 用法：
 *   node tools/wechat-login.mjs                    # 扫码并输出凭据 JSON
 *   node tools/wechat-login.mjs --write            # 扫码后自动写入 profile 配置
 *   node tools/wechat-login.mjs --profile web      # 指定 profile（默认 web）
 *   node tools/wechat-login.mjs --timeout 300      # 等待扫码秒数（默认 600）
 *
 * 流程：
 *   1. 向 iLink 申请二维码 → 终端显示 ASCII 二维码 + 链接 + 保存 PNG 并自动打开；
 *   2. 手机微信扫码并确认；
 *   3. 轮询确认结果 → 输出 bot_token / baseurl / botId；
 *   4. （--write）自动更新 $DSH_HOME/profiles/<name>/cordis.patch.yml。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE_URL = process.env.WX_BASE_URL || 'https://ilinkai.weixin.qq.com'

function parseArgs(argv) {
  const args = { write: false, profile: 'web', timeout: 600 }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--write') args.write = true
    else if (a === '--profile') args.profile = argv[++i]
    else if (a === '--timeout') args.timeout = Number(argv[++i]) || 600
    else if (a === '--help' || a === '-h') {
      console.log('用法: node tools/wechat-login.mjs [--write] [--profile <name>] [--timeout <秒>]')
      process.exit(0)
    }
  }
  return args
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ilinkHeaders() {
  const n = Math.floor(Math.random() * 0xffffffff)
  return {
    'Content-Type': 'application/json',
    'X-WECHAT-UIN': Buffer.from(String(n), 'utf8').toString('base64'),
  }
}

async function main() {
  const args = parseArgs(process.argv)
  console.log('→ 向 iLink 申请二维码…')

  // 1. QR code
  const qr = await (await fetch(`${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`)).json()
  if (qr.ret !== 0) throw new Error('获取二维码失败: ' + JSON.stringify(qr))
  console.log('\n📱 扫码链接（浏览器打开或直接扫码）:')
  console.log('  ' + qr.qrcode_img_content)
  console.log()

  // 2. Render: ASCII terminal QR — 必须编码完整链接 qrcode_img_content，
  //    微信扫码后才会进入登录确认页；编码裸 qrcode id 会扫出一串乱码文本。
  try {
    const QRCode = (await import('qrcode')).default
    const ascii = await QRCode.toString(qr.qrcode_img_content, { type: 'terminal', small: true })
    console.log('┌─ 二维码（手机微信扫一扫）─' + '─'.repeat(20) + '┐')
    console.log(ascii)
    console.log('└' + '─'.repeat(48) + '┘')
  } catch {
    console.log('（终端二维码渲染失败，请使用上面的链接）')
  }

  // 3. Poll for confirmation
  console.log('\n⏳ 等待手机扫码确认（' + args.timeout + ' 秒超时）…')
  const deadline = Date.now() + args.timeout * 1000
  let confirmed = null
  while (Date.now() < deadline) {
    try {
      const s = await (await fetch(`${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${qr.qrcode}`)).json()
      if (s.status === 'confirmed') { confirmed = s; break }
      if (s.status === 'expired') { console.error('✗ 二维码已过期，请重新运行本工具'); process.exit(2) }
    } catch (e) { /* transient network error, keep polling */ }
    await sleep(2000)
  }
  if (!confirmed) {
    console.error('✗ 等待超时，请重新运行本工具')
    process.exit(3)
  }

  // 4. Output credentials
  console.log('\n✅ 扫码成功！凭据如下：')
  const creds = {
    bot_token: confirmed.bot_token,
    botId: confirmed.ilink_bot_id,
    baseUrl: confirmed.baseurl,
    userId: confirmed.ilink_user_id,
  }
  console.log(JSON.stringify(creds, null, 2))

  // 5. Optional: write into the profile patch
  if (args.write) {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const patchPath = path.join(home, 'profiles', args.profile, 'cordis.patch.yml')
    if (!fs.existsSync(patchPath)) {
      console.error('\n✗ 未找到 ' + patchPath + '，请先挂载 dshplug 插件（dsh plugin --profile ' + args.profile + ' add file:<插件目录>）')
      process.exit(4)
    }
    let patch = fs.readFileSync(patchPath, 'utf8')
    if (!patch.includes('- id: dshplug')) {
      console.error('\n✗ ' + patchPath + ' 中没有 dshplug 行，请先按 README 配置插件')
      process.exit(5)
    }
    // Replace token/botId/baseUrl only inside the dshplug block, wechat section (line-based)
    const blockStart = patch.indexOf('- id: dshplug')
    const blockEnd = patch.indexOf('- id:', blockStart + 10)
    const block = blockEnd > 0 ? patch.slice(blockStart, blockEnd) : patch.slice(blockStart)
    const lines = block.split('\n')
    const wxIdx = lines.findIndex((l) => l.trim() === 'wechat:')
    if (wxIdx < 0) {
      console.error('\n✗ dshplug 行中没有 wechat 段，请先按 README 配置插件')
      process.exit(6)
    }
    const seg = [lines[wxIdx]]
    for (let i = wxIdx + 1; i < lines.length; i++) {
      const l = lines[i]
      if (/^    \S/.test(l) || !l.trim()) break // 兄弟键（4 空格缩进）或空行结束本段
      seg.push(l)
    }
    const newSeg = seg.map((l) => {
      if (/^      token: /.test(l)) return `      token: '${creds.bot_token}'`
      if (/^      botId: /.test(l)) return `      botId: '${creds.botId}'`
      if (/^      baseUrl: /.test(l)) return `      baseUrl: ${creds.baseUrl}`
      if (/^      enabled: /.test(l)) return l.replace(/enabled: false/, 'enabled: true')
      return l
    })
    const newBlock = block.replace(lines.slice(wxIdx, wxIdx + seg.length).join('\n'), newSeg.join('\n'))
    patch = blockEnd > 0 ? patch.slice(0, blockStart) + newBlock + patch.slice(blockEnd) : patch.slice(0, blockStart) + newBlock
    fs.writeFileSync(patchPath, patch, 'utf8')
    console.log('\n✅ 已写入 ' + patchPath + '（wechat.enabled=true，凭据已更新）')
    console.log('   重启 DSH profile 后生效：dsh --profile ' + args.profile)
  } else {
    console.log('\n💡 把上面的 bot_token / botId / baseUrl 填进 profile 的 cordis.patch.yml（参考 README），或加 --write 自动写入')
  }
}

main().catch((e) => {
  console.error('✗ 登录工具失败:', e.message)
  process.exit(1)
})
