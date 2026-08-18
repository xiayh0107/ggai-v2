import { describe, expect, it } from 'vitest'
import { parseComputeNodePayload, parseComputeResultSidecar } from './contracts'

describe('compute contracts', () => {
  it('accepts bounded preset code without image or command authority', () => {
    expect(parseComputeNodePayload({
      runtime: 'python-3.13', code: 'print(1)', timeoutMs: 60_000,
      memoryMb: 512, cpus: 1, pids: 64,
    }).runtime).toBe('python-3.13')
    expect(() => parseComputeNodePayload({
      runtime: 'python-3.13', code: 'print(1)', timeoutMs: 60_000,
      memoryMb: 512, cpus: 1, pids: 64, image: 'evil:latest',
    })).toThrow(/invalid/u)
  })

  it('accepts only exact, unique relative output declarations', () => {
    expect(parseComputeResultSidecar({
      schemaVersion: 1, outputs: { result: [{ path: 'result.json' }] },
    }).outputs.result).toHaveLength(1)
    expect(() => parseComputeResultSidecar({
      schemaVersion: 1, outputs: { result: [{ path: '../result.json' }] },
    })).toThrow(/invalid/u)
    expect(() => parseComputeResultSidecar({
      schemaVersion: 1,
      outputs: { first: [{ path: 'same.txt' }], second: [{ path: 'same.txt' }] },
    })).toThrow(/duplicated/u)
  })
})
