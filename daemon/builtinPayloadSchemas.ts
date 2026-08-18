import type { AnySchema } from 'ajv/dist/2020.js'
import { NodePayloadSchemaRegistry } from './nodePayloadSchemas.js'

export const BUILTIN_PAYLOAD_SCHEMAS: readonly AnySchema[] = [
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'ggai://schema/payload/content',
    type: 'object',
    properties: {
      content: { type: 'string', maxLength: 250_000 },
      bold: { type: 'boolean' },
      italic: { type: 'boolean' },
      heading: { type: 'integer', minimum: 1, maximum: 2 },
    },
    additionalProperties: false,
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'ggai://schema/payload/compute',
    type: 'object',
    required: ['runtime', 'code', 'timeoutMs', 'memoryMb', 'cpus', 'pids'],
    properties: {
      runtime: { enum: ['python-3.13', 'node-24'] },
      code: { type: 'string', minLength: 1, maxLength: 262_144 },
      timeoutMs: { type: 'integer', minimum: 1_000, maximum: 300_000 },
      memoryMb: { type: 'integer', minimum: 64, maximum: 4_096 },
      cpus: { type: 'number', minimum: 0.1, maximum: 4 },
      pids: { type: 'integer', minimum: 8, maximum: 256 },
    },
    additionalProperties: false,
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'ggai://schema/payload/asset-assembly',
    type: 'object', required: ['background', 'density'],
    properties: {
      background: { type: 'string', pattern: '^(?:#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?|transparent)$' },
      density: { type: 'number', minimum: 1, maximum: 600 },
    },
    additionalProperties: false,
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'ggai://schema/payload/asset-part',
    type: 'object', required: ['sourceRect', 'pivot', 'opacity', 'blend', 'alt'],
    properties: {
      sourceRect: { $ref: '#/$defs/rect' },
      pivot: { $ref: '#/$defs/point' },
      opacity: { type: 'number', minimum: 0, maximum: 1 },
      blend: { enum: ['normal', 'multiply', 'screen', 'overlay'] },
      clip: { $ref: '#/$defs/rect' },
      alt: { type: 'string', maxLength: 1_000 },
    },
    additionalProperties: false,
    $defs: {
      rect: {
        type: 'object', required: ['x', 'y', 'w', 'h'],
        properties: {
          x: { type: 'number' }, y: { type: 'number' },
          w: { type: 'number', exclusiveMinimum: 0, maximum: 8_192 },
          h: { type: 'number', exclusiveMinimum: 0, maximum: 8_192 },
        }, additionalProperties: false,
      },
      point: {
        type: 'object', required: ['x', 'y'],
        properties: { x: { type: 'number' }, y: { type: 'number' } },
        additionalProperties: false,
      },
    },
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'ggai://schema/payload/shape',
    type: 'object', required: ['kind', 'fill', 'stroke', 'strokeWidth', 'cornerRadius'],
    properties: {
      kind: { enum: ['rectangle', 'ellipse'] },
      fill: { type: 'string', maxLength: 64 }, stroke: { type: 'string', maxLength: 64 },
      strokeWidth: { type: 'number', minimum: 0, maximum: 1_024 },
      cornerRadius: { type: 'number', minimum: 0, maximum: 8_192 },
    },
    additionalProperties: false,
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'ggai://schema/payload/filesystem-entry',
    type: 'object', required: ['rootId', 'relativePath'],
    properties: {
      rootId: { type: 'string', pattern: '^root_[A-Za-z0-9-]+$' },
      relativePath: { type: 'string', maxLength: 4_096, pattern: '^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).*$' },
    },
    additionalProperties: false,
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'ggai://schema/payload/pdf-document',
    type: 'object', required: ['importId', 'sourcePdfDigest', 'pageCount', 'metadata'],
    properties: {
      importId: { type: 'string', pattern: '^pdf_import_[A-Za-z0-9-]+$' },
      sourcePdfDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      pageCount: { type: 'integer', minimum: 1, maximum: 10_000 },
      metadata: { type: 'object', additionalProperties: { type: 'string', nullable: true } },
    }, additionalProperties: false,
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'ggai://schema/payload/pdf-page',
    type: 'object', required: ['sourcePdfDigest', 'pageNumber', 'width', 'height', 'rotation'],
    properties: {
      sourcePdfDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      pageNumber: { type: 'integer', minimum: 1, maximum: 10_000 },
      width: { type: 'number', exclusiveMinimum: 0, maximum: 100_000 },
      height: { type: 'number', exclusiveMinimum: 0, maximum: 100_000 },
      rotation: { type: 'integer', enum: [0, 90, 180, 270] },
    }, additionalProperties: false,
  },
  ...['pdf-text-block', 'pdf-annotation'].map((kind): AnySchema => ({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `ggai://schema/payload/${kind}`,
    type: 'object',
    required: kind === 'pdf-text-block'
      ? ['pageNumber', 'bbox', 'text']
      : ['pageNumber', 'bbox', 'subtype', 'contents'],
    properties: {
      pageNumber: { type: 'integer', minimum: 1, maximum: 10_000 },
      bbox: { $ref: '#/$defs/bbox' },
      ...(kind === 'pdf-text-block'
        ? { text: { type: 'string', maxLength: 250_000 } }
        : {
            subtype: { type: 'string', minLength: 1, maxLength: 120 },
            contents: { type: 'string', maxLength: 100_000 },
          }),
    },
    $defs: { bbox: bboxSchema() },
    additionalProperties: false,
  })),
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'ggai://schema/payload/pdf-image',
    type: 'object', required: ['pageNumber', 'bbox', 'artifactRef', 'alt'],
    properties: {
      pageNumber: { type: 'integer', minimum: 1, maximum: 10_000 },
      bbox: { $ref: '#/$defs/bbox' },
      artifactRef: {
        type: 'object', required: ['runId', 'artifactId'],
        properties: {
          runId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:@-]*$' },
          artifactId: { type: 'string', pattern: '^artifact_[0-9a-f]{64}$' },
        }, additionalProperties: false,
      },
      alt: { type: 'string', maxLength: 1_000 },
    },
    $defs: { bbox: bboxSchema() },
    additionalProperties: false,
  },
]

export function createBuiltinPayloadSchemaRegistry(): NodePayloadSchemaRegistry {
  const registry = new NodePayloadSchemaRegistry()
  for (const schema of BUILTIN_PAYLOAD_SCHEMAS) registry.add(schema)
  return registry
}

function bboxSchema(): AnySchema {
  return {
    type: 'object', required: ['x', 'y', 'w', 'h'],
    properties: {
      x: { type: 'number', minimum: 0, maximum: 100_000 },
      y: { type: 'number', minimum: 0, maximum: 100_000 },
      w: { type: 'number', exclusiveMinimum: 0, maximum: 100_000 },
      h: { type: 'number', exclusiveMinimum: 0, maximum: 100_000 },
    }, additionalProperties: false,
  }
}
