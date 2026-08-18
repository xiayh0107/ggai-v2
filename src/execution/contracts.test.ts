import { describe, expect, it } from 'vitest'
import {
  MAX_EXECUTION_OUTPUT_ITEMS,
  validateExecutionOutputs,
} from './contracts'

describe('execution output contract', () => {
  it('bounds fan-out and inline JSON while preserving artifact identities', () => {
    expect(() => validateExecutionOutputs({
      result: Array.from({ length: MAX_EXECUTION_OUTPUT_ITEMS + 1 }, () => ({
        kind: 'json' as const,
        value: 1,
      })),
    })).toThrow(/1024/u)
    expect(() => validateExecutionOutputs({
      result: [{ kind: 'json', value: 'x'.repeat(256 * 1024) }],
    })).toThrow(/too large/u)
    expect(validateExecutionOutputs({
      image: [{
        kind: 'artifact',
        runId: 'execution-run',
        artifactId: `artifact_${'a'.repeat(64)}`,
      }],
    })).toHaveLength(1)
  })
})
