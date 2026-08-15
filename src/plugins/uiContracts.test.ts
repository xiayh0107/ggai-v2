import { describe, expect, it } from 'vitest'
import {
  NODE_UI_SCHEMA_VERSION,
  defineNodeUi,
  inspectNodeUiDefinition,
} from './uiContracts'

describe('Node UI contract', () => {
  it('accepts a strict platform template definition', () => {
    expect(inspectNodeUiDefinition(defineNodeUi('document'))).toEqual({
      status: 'valid',
      definition: { schemaVersion: NODE_UI_SCHEMA_VERSION, template: 'document' },
    })
  })

  it('rejects arbitrary UI fields, CSS hooks and unsupported templates', () => {
    expect(inspectNodeUiDefinition({
      schemaVersion: 1,
      template: 'document',
      className: 'bg-red-500',
    }).status).toBe('invalid')
    expect(inspectNodeUiDefinition({ schemaVersion: 1, template: 'custom-jsx' }).status)
      .toBe('invalid')
    expect(inspectNodeUiDefinition({ schemaVersion: 2, template: 'document' }).status)
      .toBe('invalid')
  })
})
