import { describe, expect, it } from 'vitest'
import { defineNodeContextPolicy, NODE_CONTEXT_POLICY_SCHEMA_VERSION } from './contextContracts'
import {
  inspectNodeTypeDefinition,
  type NodeTypeDefinition,
} from './nodeTypeContracts'
import { NodePayloadSchemaRegistry } from '../../daemon/nodePayloadSchemas'
import { defineNodeUi } from './uiContracts'

function definition(): NodeTypeDefinition {
  return {
    schemaVersion: 2,
    id: '@local/chart',
    revision: 1,
    label: '图表',
    description: '根据数据绘制图表',
    creatable: true,
    icon: 'graphic',
    defaultWidth: 360,
    initialPayloadSchema: 'ggai://schema/payload/chart',
    initialPayload: { title: '' },
    ui: defineNodeUi('card'),
    instruction: {
      placeholder: '描述图表…',
      actions: ['检查数据'],
      marks: [],
    },
    containment: {
      canHaveChildren: false,
      allowedChildTypes: [],
      maxDepth: 0,
    },
    ports: [{
      key: 'data',
      direction: 'input',
      schema: 'ggai://value/json',
      cardinality: 'one',
    }, {
      key: 'image',
      direction: 'output',
      schema: 'ggai://value/image',
      cardinality: 'one',
      materialization: 'tray',
    }],
    exporters: ['png'],
    agent: {
      constructible: true,
      writableInitSchema: 'ggai://schema/payload/chart',
    },
    artifactClaims: [],
    nodeContext: defineNodeContextPolicy({
      schemaVersion: NODE_CONTEXT_POLICY_SCHEMA_VERSION,
      summary: { textMaxChars: 0, payloadFields: ['title'] },
      full: { textMaxChars: 0, payloadFields: ['title'], artifactRefs: 'none' },
    }),
  }
}

describe('NodeTypeDefinition', () => {
  it('accepts the strict serializable capability contract', () => {
    const inspection = inspectNodeTypeDefinition(definition())
    expect(inspection.status).toBe('valid')
    if (inspection.status === 'valid') {
      expect(inspection.definition).toEqual(definition())
      expect(inspection.definition).not.toBe(definition())
    }
  })

  it('rejects authority fields and duplicate direction/port keys', () => {
    expect(inspectNodeTypeDefinition({
      ...definition(),
      command: 'python unsafe.py',
    }).status).toBe('invalid')
    expect(inspectNodeTypeDefinition({
      ...definition(),
      ports: [definition().ports[0], definition().ports[0]],
    })).toEqual({ status: 'invalid', reason: 'ports contain duplicate direction/key pairs' })
  })

  it('validates payloads only against locally registered 2020-12 schemas', () => {
    const registry = new NodePayloadSchemaRegistry()
    registry.add({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'ggai://schema/payload/chart',
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: { title: { type: 'string', maxLength: 120 } },
    })
    expect(registry.validate('ggai://schema/payload/chart', { title: 'Quarterly' }))
      .toEqual({ valid: true })
    expect(registry.validate('ggai://schema/payload/chart', {
      title: 'Quarterly',
      command: 'curl example.com',
    })).toMatchObject({ valid: false })
    expect(() => registry.add({
      $id: 'https://example.com/remote.json',
      type: 'object',
    })).toThrow(/daemon-owned/u)
    registry.add({
      $id: 'ggai://schema/payload/remote',
      $ref: 'https://example.com/missing.json',
    })
    expect(() => registry.validator('ggai://schema/payload/remote'))
      .toThrow(/resolve reference|missing/iu)
  })
})
