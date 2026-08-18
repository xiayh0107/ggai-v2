import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'
import { registerBuiltinPlugins } from '@/plugins/builtins'
import { DAEMON_URL } from '@/agent/config'
import { NodeDefinitionClient } from '@/node-studio/client'
import { registerNodeStudioDefinitions } from '@/node-studio/runtime'

// 注册全部内置节点插件（与社区 / 用户插件完全同构）
registerBuiltinPlugins()

void new NodeDefinitionClient({ baseUrl: DAEMON_URL }).list()
  .then(registerNodeStudioDefinitions)
  .catch(() => undefined)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
