import { describe, expect, it, vi } from 'vitest'
import { ensureDaemonAvailable } from './daemon'

describe('CLI daemon bootstrap', () => {
  it('reuses a healthy daemon without spawning', async () => {
    const spawnProcess = vi.fn()
    await ensureDaemonAvailable({
      baseUrl: 'http://127.0.0.1:7380',
      fetch: async () => new Response('{}', { status: 200 }),
      environment: {},
    }, {
      accessFile: vi.fn(),
      spawnProcess: spawnProcess as never,
    })
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('starts a packaged loopback daemon and waits for health', async () => {
    let probes = 0
    const unref = vi.fn()
    const spawnProcess = vi.fn(() => ({ unref }))
    const onStarted = vi.fn()
    await ensureDaemonAvailable({
      baseUrl: 'http://127.0.0.1:7391',
      fetch: async () => {
        probes += 1
        if (probes === 1) throw new TypeError('offline')
        return new Response('{}', { status: 200 })
      },
      environment: { GGAI_PROJECT_ROOT: '/workspace' },
      onStarted,
    }, {
      daemonPath: '/package/dist-daemon/daemon/index.js',
      workingDirectory: '/package',
      accessFile: vi.fn(async () => undefined),
      spawnProcess: spawnProcess as never,
      sleep: vi.fn(async () => undefined),
    })

    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      [
        '/package/dist-daemon/daemon/index.js',
        '--project-root',
        '/workspace',
        '--port',
        '7391',
      ],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    )
    expect(unref).toHaveBeenCalledOnce()
    expect(onStarted).toHaveBeenCalledWith('http://127.0.0.1:7391')
  })

  it('never auto-starts a remote daemon', async () => {
    await expect(ensureDaemonAvailable({
      baseUrl: 'https://daemon.example.com',
      fetch: async () => { throw new TypeError('offline') },
      environment: {},
    })).rejects.toThrow('loopback-only')
  })

  it('uses the current workspace and the HTTP default port', async () => {
    let probes = 0
    const spawnProcess = vi.fn(() => ({ unref: vi.fn() }))
    await ensureDaemonAvailable({
      baseUrl: 'http://localhost',
      fetch: async () => {
        probes += 1
        if (probes === 1) throw new TypeError('offline')
        return new Response('{}', { status: 200 })
      },
      environment: {},
    }, {
      daemonPath: '/package/dist-daemon/daemon/index.js',
      workingDirectory: '/workspace',
      accessFile: vi.fn(async () => undefined),
      spawnProcess: spawnProcess as never,
      sleep: vi.fn(async () => undefined),
    })

    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      [
        '/package/dist-daemon/daemon/index.js',
        '--project-root',
        '/workspace',
        '--port',
        '80',
      ],
      expect.any(Object),
    )
  })

  it('does not auto-start the IPv6 address that the packaged daemon cannot bind', async () => {
    await expect(ensureDaemonAvailable({
      baseUrl: 'http://[::1]:7380',
      fetch: async () => { throw new TypeError('offline') },
      environment: {},
    })).rejects.toThrow('loopback-only')
  })

  it('stops the exact child when startup never becomes healthy', async () => {
    const kill = vi.fn()
    await expect(ensureDaemonAvailable({
      baseUrl: 'http://127.0.0.1:7391',
      fetch: async () => { throw new TypeError('offline') },
      environment: {},
    }, {
      daemonPath: '/package/dist-daemon/daemon/index.js',
      workingDirectory: '/workspace',
      accessFile: vi.fn(async () => undefined),
      spawnProcess: vi.fn(() => ({ unref: vi.fn(), kill })) as never,
      sleep: vi.fn(async () => undefined),
    })).rejects.toThrow('did not become ready')

    expect(kill).toHaveBeenCalledOnce()
  })
})
