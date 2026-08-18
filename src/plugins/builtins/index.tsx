import { registerPlugin, unregisterPlugin } from '@/plugins/types'
import { BUILTIN_NODE_TYPE_DEFINITIONS } from './definitions'

let registered = false

export function registerBuiltinPlugins() {
  if (registered) return
  registered = true
  BUILTIN_NODE_TYPE_DEFINITIONS.forEach(registerPlugin)
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    BUILTIN_NODE_TYPE_DEFINITIONS.forEach((plugin) => unregisterPlugin(plugin.id))
    registered = false
  })
}
