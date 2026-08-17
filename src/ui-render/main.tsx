import { createRoot } from 'react-dom/client'
import { registerBuiltinPlugins } from '@/plugins/builtins'
import '../index.css'
import UiRenderLab from './UiRenderLab'
import { getUiRenderScenario } from './scenarios'

registerBuiltinPlugins()

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('UI render root is missing')

const scenarioId = new URL(globalThis.location.href).searchParams.get('scenario')
if (scenarioId) {
  const scenario = getUiRenderScenario(scenarioId)
  document.title = `${scenario.title} · GGAI UI Render`
  createRoot(rootElement).render(scenario.render())
} else {
  document.title = '本地 UI 状态实验室 · GGAI'
  createRoot(rootElement).render(<UiRenderLab />)
}
