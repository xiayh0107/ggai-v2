export const MAX_ASSET_DIMENSION = 8_192
export const MAX_ASSET_PARTS = 1_024

export type AssetBlendMode = 'normal' | 'multiply' | 'screen' | 'overlay'

export interface AssetAssemblyPayload {
  background: string
  density: number
}

export interface AssetPartPayload {
  sourceRect: { x: number; y: number; w: number; h: number }
  pivot: { x: number; y: number }
  opacity: number
  blend: AssetBlendMode
  clip?: { x: number; y: number; w: number; h: number }
  alt: string
}

export interface ShapePayload {
  kind: 'rectangle' | 'ellipse'
  fill: string
  stroke: string
  strokeWidth: number
  cornerRadius: number
}

export function parseAssetAssemblyPayload(value: unknown): AssetAssemblyPayload {
  if (!isRecord(value) || !exactKeys(value, ['background', 'density'])
    || !validColor(value.background)
    || !finiteInRange(value.density, 1, 600)) {
    throw new TypeError('asset assembly payload is invalid')
  }
  return structuredClone(value) as unknown as AssetAssemblyPayload
}

export function parseAssetPartPayload(value: unknown): AssetPartPayload {
  if (!isRecord(value)) throw new TypeError('asset part payload is invalid')
  const expected = ['alt', 'blend', 'opacity', 'pivot', 'sourceRect']
  if (value.clip !== undefined) expected.push('clip')
  if (!exactKeys(value, expected)
    || !validRect(value.sourceRect)
    || !validPoint(value.pivot)
    || !finiteInRange(value.opacity, 0, 1)
    || !['normal', 'multiply', 'screen', 'overlay'].includes(String(value.blend))
    || (value.clip !== undefined && !validRect(value.clip))
    || typeof value.alt !== 'string' || value.alt.length > 1_000) {
    throw new TypeError('asset part payload is invalid')
  }
  return structuredClone(value) as unknown as AssetPartPayload
}

export function parseShapePayload(value: unknown): ShapePayload {
  if (!isRecord(value)
    || !exactKeys(value, ['cornerRadius', 'fill', 'kind', 'stroke', 'strokeWidth'])
    || !['rectangle', 'ellipse'].includes(String(value.kind))
    || !validColor(value.fill) || !validColor(value.stroke)
    || !finiteInRange(value.strokeWidth, 0, 1_024)
    || !finiteInRange(value.cornerRadius, 0, MAX_ASSET_DIMENSION)) {
    throw new TypeError('shape payload is invalid')
  }
  return structuredClone(value) as unknown as ShapePayload
}

function validRect(value: unknown): boolean {
  return isRecord(value)
    && exactKeys(value, ['h', 'w', 'x', 'y'])
    && finiteInRange(value.x, -MAX_ASSET_DIMENSION, MAX_ASSET_DIMENSION)
    && finiteInRange(value.y, -MAX_ASSET_DIMENSION, MAX_ASSET_DIMENSION)
    && finiteInRange(value.w, Number.EPSILON, MAX_ASSET_DIMENSION)
    && finiteInRange(value.h, Number.EPSILON, MAX_ASSET_DIMENSION)
}

function validPoint(value: unknown): boolean {
  return isRecord(value)
    && exactKeys(value, ['x', 'y'])
    && finiteInRange(value.x, -MAX_ASSET_DIMENSION, MAX_ASSET_DIMENSION)
    && finiteInRange(value.y, -MAX_ASSET_DIMENSION, MAX_ASSET_DIMENSION)
}

function validColor(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64
    && (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value) || value === 'transparent')
}

function finiteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length
    && keys.every((key, index) => key === expected.sort()[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
