import type { JsonSchemaDefinition } from '@openai/agents';

/**
 * The shape of `outputFormat` as stored in a LaunchDarkly AI config variation.
 * It is the raw JSON Schema content — the object that goes inside the `schema`
 * wrapper, not the wrapper itself.
 */
export type LDOutputFormat = {
  type?: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
  description?: string;
  [key: string]: unknown;
};

/**
 * Converts the `outputFormat` from an LD AI config into the `JsonSchemaDefinition`
 * shape that the OpenAI Agents SDK accepts as `outputType` on an `Agent`.
 *
 * LD stores only the raw JSON Schema content (properties, required, etc.) while
 * the SDK expects a wrapper: `{ type: 'json_schema', name, strict, schema: <content> }`.
 * This function builds that wrapper and applies two normalizations required by the
 * OpenAI Structured Outputs API:
 *
 * 1. Ensures `type: 'object'` is present at the schema root.
 * 2. Populates `required` with all property keys when `properties` is defined.
 *    OpenAI requires every property to appear in `required` when
 *    `additionalProperties: false` is set — optional fields should use a
 *    nullable type (e.g. `["string", "null"]`) rather than being omitted from
 *    `required`.  Auto-filling prevents a common misconfiguration in LD AI config
 *    variations that have `"required": []`.
 *
 * Returns `undefined` if `outputFormat` is absent or empty.
 */
export function buildOutputType(outputFormat: Record<string, unknown> | undefined): JsonSchemaDefinition | undefined {
  if (!outputFormat || Object.keys(outputFormat).length === 0) return undefined;

  const properties = outputFormat.properties as Record<string, unknown> | undefined;
  const required = properties ? Object.keys(properties) : (outputFormat.required as string[] | undefined);

  const schema: LDOutputFormat = {
    ...outputFormat,
    type: 'object',
    ...(required && required.length > 0 ? { required } : {}),
  };

  return {
    type: 'json_schema',
    name: 'output',
    strict: false,
    schema: schema as JsonSchemaDefinition['schema'],
  };
}
