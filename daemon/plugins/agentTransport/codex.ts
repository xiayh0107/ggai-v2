import type { SynchronousCapabilityPlugin } from '../../runtime/pluginHost.js'
import {
  compatibilityError,
  lastUsefulLine,
  resolveExecutable,
  runProbe,
} from '../../transport/probe.js'
import {
  AGENT_TRANSPORT_REGISTRY_SERVICE,
  type AgentTransportProvider,
} from '../../transport/registry.js'
import { CodexTransport } from '../../transport/codex.js'

export interface CodexAgentTransportPluginOptions {
  command?: string
}

export function createCodexAgentTransportPlugin(
  options: CodexAgentTransportPluginOptions = {},
): SynchronousCapabilityPlugin {
  const command = resolveExecutable(options.command ?? 'codex') ?? options.command ?? 'codex'
  const transport = new CodexTransport({ command })
  const provider: AgentTransportProvider = {
    id: '@ggai/agent-transport-codex',
    agentIds: ['codex'],
    async probe() {
      const version = await runProbe(command, ['--version'])
      if (!version.found) return []
      const [login, execHelp, resumeHelp] = version.code === 0
        ? await Promise.all([
            runProbe(command, ['login', 'status']),
            runProbe(command, ['exec', '--help']),
            runProbe(command, ['exec', 'resume', '--help']),
          ])
        : [null, null, null]
      const incompatibility = execHelp && resumeHelp
        ? compatibilityError(
            [execHelp, resumeHelp],
            [
              {
                label: 'codex exec',
                options: ['--json', '--color', '--sandbox', '--cd', '--add-dir', '--skip-git-repo-check'],
              },
              { label: 'codex exec resume', options: ['--json'] },
            ],
          )
        : undefined
      const authenticated = login?.code === 0 && /logged in|authenticated/iu.test(login.output)
      return [{
        id: 'codex',
        label: 'Codex',
        transport: 'codex' as const,
        available: version.code === 0 && incompatibility === undefined,
        authStatus: authenticated ? 'authenticated' as const
          : login?.code === 0 ? 'unknown' as const : 'unauthenticated' as const,
        version: version.code === 0 ? lastUsefulLine(version.output) : undefined,
        binaryPath: version.binaryPath,
        detail: version.code === 0 ? incompatibility : version.output,
        models: [],
      }]
    },
    resolve(agentId) {
      return agentId === 'codex' ? transport : null
    },
  }

  return {
    manifest: {
      id: '@ggai/agent-transport-codex',
      version: '1.0.0',
      apiVersion: 1,
      displayName: 'Codex transport',
    },
    activate(context) {
      return context.require(AGENT_TRANSPORT_REGISTRY_SERVICE).register(provider)
    },
  }
}
