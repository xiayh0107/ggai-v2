import { describe, expect, it } from 'vitest'
import {
  parseAssetAssemblyPayload,
  parseAssetPartPayload,
  parseShapePayload,
} from './contracts'

describe('asset contracts', () => {
  it('accepts exact assembly, part, and shape payloads', () => {
    expect(parseAssetAssemblyPayload({ background: '#ffffff00', density: 144 })).toEqual({
      background: '#ffffff00', density: 144,
    })
    expect(parseAssetPartPayload({
      sourceRect: { x: 0, y: 0, w: 100, h: 80 },
      pivot: { x: 50, y: 40 }, opacity: 0.5, blend: 'multiply', alt: 'Layer',
    }).blend).toBe('multiply')
    expect(parseShapePayload({
      kind: 'rectangle', fill: '#112233', stroke: 'transparent', strokeWidth: 0, cornerRadius: 8,
    }).kind).toBe('rectangle')
  })

  it('rejects escape fields and unsafe numeric values', () => {
    expect(() => parseAssetAssemblyPayload({
      background: '#ffffff', density: 144, command: 'open',
    })).toThrow(/invalid/u)
    expect(() => parseAssetPartPayload({
      sourceRect: { x: 0, y: 0, w: Infinity, h: 80 },
      pivot: { x: 0, y: 0 }, opacity: 1, blend: 'normal', alt: '',
    })).toThrow(/invalid/u)
  })
})
