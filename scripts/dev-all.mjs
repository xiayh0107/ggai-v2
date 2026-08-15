#!/usr/bin/env node
/**
 * 一条命令同时启动 Vite 前端与本地 Agent daemon（产品快速迭代用）。
 *
 *   npm run dev                       # daemon(7380) + vite(3000)
 *   npm run dev -- --port 7100        # 额外参数透传给 Vite，Origin 自动同步
 *   npm run dev:all                   # 向后兼容别名
 *
 * 行为：
 * - 先增量构建 daemon（tsc，通常秒级），再并行拉起两个进程；
 * - 监听 daemon/ 与共享前端源码（src/canvas、src/agent、src/types，
 *   即 tsconfig.daemon.json 的 include）变更：自动重新构建并重启 daemon，
 *   Vite 不受影响；
 * - 输出统一加 [daemon] / [vite] / [dev] 前缀；
 * - Ctrl+C 一次退出全部进程；任一进程意外退出时结束其余进程。
 */
import { spawn } from 'node:child_process'
import process from 'node:process'
import chokidar from 'chokidar'
import {
  resolveCodexCommand,
  viteBrowserOrigins,
} from './dev-all-options.mjs'

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const viteArgs = process.argv.slice(2)

const codexCommand = resolveCodexCommand({
  explicitCommand: process.env.GGAI_CODEX_COMMAND,
  pathValue: process.env.PATH,
})
let allowedOrigins
try {
  allowedOrigins = viteBrowserOrigins(viteArgs)
} catch (error) {
  process.stderr.write(`[dev] 参数错误：${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

let shuttingDown = false
let daemonChild = null
let viteChild = null
let restarting = false
let restartQueued = false
let debounceTimer = null

function shutdown(exitCode, signal = 'SIGINT') {
  if (shuttingDown) return
  shuttingDown = true
  if (debounceTimer) clearTimeout(debounceTimer)
  for (const child of [daemonChild, viteChild]) {
    if (child && !child.killed) child.kill(signal)
  }
  // 给子进程一点退出时间，避免终端光标/输出状态残留
  setTimeout(() => process.exit(exitCode), 300).unref()
}

function pipePrefix(child, tag) {
  for (const [stream, out] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    if (!stream) continue
    let pending = ''
    stream.on('data', (chunk) => {
      pending += chunk.toString()
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) out.write(`${tag} ${line}\n`)
      }
    })
    stream.on('end', () => {
      if (pending.trim()) out.write(`${tag} ${pending}\n`)
    })
  }
}

function buildDaemon() {
  return new Promise((resolve) => {
    const build = spawn(npmCmd, ['run', 'build:daemon'], { cwd: process.cwd(), stdio: 'inherit' })
    build.on('exit', (code) => resolve(code === 0))
    build.on('error', () => resolve(false))
  })
}

function startDaemon() {
  const daemonArgs = [
    'dist-daemon/daemon/index.js',
    '--project-root', process.cwd(),
    '--codex-command', codexCommand,
  ]
  for (const origin of allowedOrigins) daemonArgs.push('--allow-origin', origin)
  daemonChild = spawn('node', daemonArgs, { cwd: process.cwd(), env: process.env })
  pipePrefix(daemonChild, '[daemon]')
  daemonChild.on('exit', (code, signal) => {
    if (shuttingDown || restarting) return
    const reason = signal ? `收到 ${signal}` : `退出码 ${code}`
    process.stderr.write(`[daemon] 已停止（${reason}），正在结束其余进程…\n`)
    shutdown(code ?? 1)
  })
  daemonChild.on('error', (error) => {
    if (shuttingDown || restarting) return
    process.stderr.write(`[daemon] 启动失败：${error.message}\n`)
    shutdown(1)
  })
}

function stopDaemon() {
  return new Promise((resolve) => {
    if (!daemonChild || daemonChild.exitCode !== null) return resolve(false)
    const child = daemonChild
    let forced = false
    const force = setTimeout(() => {
      // `child.killed` only means a signal was sent; it becomes true as soon as
      // SIGINT is requested even when the process is still shutting down.
      if (child.exitCode === null && child.signalCode === null) {
        forced = true
        child.kill('SIGKILL')
      }
    }, 10_000)
    child.once('exit', () => { clearTimeout(force); resolve(forced) })
    child.kill('SIGINT')
  })
}

/** 源码变更后的 daemon 重启：杀掉 → 重新构建 → 拉起；期间的新变更排队合并 */
async function restartDaemon() {
  if (restarting) { restartQueued = true; return }
  restarting = true
  const forced = await stopDaemon()
  if (forced) {
    process.stderr.write(
      '[dev] daemon 未能安全退出，已停止自动重启。确认没有 daemon 后删除项目内的 .gg/runtime/canvas-daemon.lock，再重新运行 npm run dev。\n',
    )
    shutdown(1)
    return
  }
  if (!shuttingDown) {
    process.stdout.write('[dev] 重新构建 daemon…\n')
    if (await buildDaemon()) startDaemon()
    else process.stderr.write('[dev] daemon 构建失败，等待下一次变更…\n')
  }
  restarting = false
  if (restartQueued && !shuttingDown) {
    restartQueued = false
    void restartDaemon()
  }
}

function startVite() {
  // 直接拉起 vite 入口而不是 npm shim，保证 Ctrl+C 时信号能干净地结束进程树
  viteChild = spawn('node', ['node_modules/vite/bin/vite.js', ...viteArgs], {
    cwd: process.cwd(), env: process.env,
  })
  pipePrefix(viteChild, '[vite]  ')
  viteChild.on('exit', (code, signal) => {
    if (shuttingDown) return
    const reason = signal ? `收到 ${signal}` : `退出码 ${code}`
    process.stderr.write(`[vite]   已停止（${reason}），正在结束其余进程…\n`)
    shutdown(code ?? 1)
  })
  viteChild.on('error', (error) => {
    if (shuttingDown) return
    process.stderr.write(`[vite]   启动失败：${error.message}\n`)
    shutdown(1)
  })
}

function watchDaemonSources() {
  // daemon 打包会编译进共享前端源码（见 tsconfig.daemon.json 的 include：
  // src/canvas、src/agent、src/types）。这些目录的变更同样要重建并重启
  // daemon，否则 daemon 会带着旧版共享 reducer 继续跑（浏览器乐观更新已被
  // HMR 修复，但 daemon 权威状态会把旧行为写回来）。
  const watcher = chokidar.watch(['daemon', 'src/canvas', 'src/agent', 'src/types'], {
    ignoreInitial: true,
    ignored: /(^|[/\\])\../,
  })
  watcher.on('all', (_event, file) => {
    if (shuttingDown) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      process.stdout.write(`[dev] 检测到 ${file} 变更，正在重启 daemon…\n`)
      void restartDaemon()
    }, 300)
  })
  watcher.on('error', (error) => {
    process.stderr.write(`[dev] 文件监听失败（自动重启已停用）：${error.message}\n`)
  })
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0, 'SIGTERM'))

process.stdout.write('[dev] 构建 daemon…\n')
if (await buildDaemon()) {
  process.stdout.write(`[dev] codex: ${codexCommand}\n`)
  process.stdout.write(`[dev] browser origins: ${allowedOrigins.join(', ')}\n`)
  startDaemon()
  startVite()
  watchDaemonSources()
} else {
  process.stderr.write('[dev] daemon 构建失败\n')
  process.exit(1)
}
