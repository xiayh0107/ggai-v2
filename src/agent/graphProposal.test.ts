import { describe, expect, it } from 'vitest'
import { inspectGraphProposal } from './graphProposal'

describe('GraphProposal', () => {
  it('accepts logical nodes and port edges without Canvas authority', () => {
    expect(inspectGraphProposal({
      nodes: [
        { key: 'source', typeId: 'text', title: 'Source', init: { content: 'hello' } },
        { key: 'result', typeId: 'text', title: 'Result', init: {}, parentKey: 'source' },
      ],
      edges: [{ fromKey: 'source', fromPort: 'content', toKey: 'result', toPort: 'content-in' }],
    }).status).toBe('valid')
  })

  it.each([
    { init: { id: 'node-forged' } },
    { init: { x: 10, y: 20 } },
    { init: { path: '/tmp/escape' } },
    { init: { command: 'rm' } },
    { init: { image: 'evil:latest' } },
    { init: { secret: 'token' } },
    { init: { autoRun: true } },
  ])('rejects authority and secret injection: $init', ({ init }) => {
    expect(inspectGraphProposal({
      nodes: [{ key: 'node', typeId: 'text', title: 'Node', init }], edges: [],
    }).status).toBe('invalid')
  })
})
