import { describe, expect, it } from 'vitest'
import { filesystemTextKind, validFilesystemRelativePath } from './contracts'

describe('filesystem contracts', () => {
  it('keeps workspace paths relative and rejects traversal', () => {
    expect(validFilesystemRelativePath('src/app.ts')).toBe(true)
    expect(validFilesystemRelativePath('../secret')).toBe(false)
    expect(validFilesystemRelativePath('/absolute')).toBe(false)
    expect(validFilesystemRelativePath('src\\app.ts')).toBe(false)
  })

  it('limits bidirectional bindings to explicit text and code formats', () => {
    expect(filesystemTextKind('README.md')).toBe(true)
    expect(filesystemTextKind('data.csv')).toBe(true)
    expect(filesystemTextKind('image.png')).toBe(false)
    expect(filesystemTextKind('archive.zip')).toBe(false)
  })
})
