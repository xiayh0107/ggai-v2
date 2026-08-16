import { createRoot } from 'react-dom/client'
import '../index.css'
import { getUiRenderScenario } from './scenarios'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('UI render root is missing')

const scenarioId = new URL(globalThis.location.href).searchParams.get('scenario')
  ?? 'task-run-draft'
const scenario = getUiRenderScenario(scenarioId)
document.title = `${scenario.title} · GGAI UI Render`

createRoot(rootElement).render(scenario.render())
