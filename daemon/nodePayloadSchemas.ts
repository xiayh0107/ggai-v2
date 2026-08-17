import { Ajv2020, type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import { isNodeSchemaId } from '../src/plugins/nodeTypeContracts.js'

export class NodePayloadSchemaRegistry {
  readonly #ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  })

  add(schema: AnySchema): void {
    if (!isRecord(schema) || !isNodeSchemaId(schema.$id)) {
      throw new TypeError('Node payload schema must have a daemon-owned ggai:// $id')
    }
    if (this.#ajv.getSchema(schema.$id)) {
      throw new TypeError(`Node payload schema is already registered: ${schema.$id}`)
    }
    this.#ajv.addSchema(schema)
  }

  validator(schemaId: string): ValidateFunction {
    if (!isNodeSchemaId(schemaId)) throw new TypeError('Node payload schema id is invalid')
    const validate = this.#ajv.getSchema(schemaId)
    if (!validate) throw new TypeError(`Node payload schema is not registered: ${schemaId}`)
    return validate
  }

  validate(schemaId: string, value: unknown): { valid: true } | {
    valid: false
    errors: ErrorObject[]
  } {
    const validate = this.validator(schemaId)
    if (validate(value)) return { valid: true }
    return { valid: false, errors: structuredClone(validate.errors ?? []) }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
