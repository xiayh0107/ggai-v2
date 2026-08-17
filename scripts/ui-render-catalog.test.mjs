import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { parseUiRenderCatalog } from './ui-render-catalog.mjs'

test('UI render catalog tracks ordered journeys and executable design checks', async () => {
  const catalog = parseUiRenderCatalog(JSON.parse(await readFile(
    new URL('../ui-render/scenarios.json', import.meta.url),
    'utf8',
  )))

  assert.ok(catalog.scenarios.length >= 9)
  assert.ok(catalog.scenarios.some((scenario) => scenario.id === 'node-lifecycle-generating'))
  assert.ok(catalog.scenarios.every((scenario) => scenario.checks.length > 0))
  assert.ok(catalog.scenarios.every((scenario) => scenario.state.controlOwner))
})

test('UI render catalog rejects ambiguous journey steps', () => {
  assert.throws(() => parseUiRenderCatalog({
    schemaVersion: 2,
    principles: [{ id: 'content', label: '内容优先', description: '内容是主角' }],
    journeys: [{ id: 'flow', label: '流程', description: '状态流程' }],
    scenarios: [1, 2].map((suffix) => ({
      id: `scenario-${suffix}`,
      title: `场景 ${suffix}`,
      description: '场景说明',
      journeyId: 'flow',
      step: 1,
      viewport: { width: 800, height: 600 },
      readySelector: 'body',
      state: {
        phase: '空白',
        selection: '未选中',
        controlOwner: 'Task',
        disclosure: '概览',
      },
      principleIds: ['content'],
      checkpoints: ['检查层次'],
      checks: [{ kind: 'selector-visible', selector: 'body', label: '页面可见' }],
    })),
  }), /duplicate step/u)
})
