import { SchemaError } from "./errors.js";
import type { FieldMeta } from "./field.js";
import type { SchemaDefinition } from "./types.js";

export interface ResolvedField {
  name: string;
  meta: FieldMeta;
}

export interface ResolvedSchema<S extends SchemaDefinition = SchemaDefinition> {
  tableName: string;
  fields: Record<keyof S & string, ResolvedField>;
  fieldNames: Array<keyof S & string>;
  indexedFields: Array<keyof S & string>;
  uniqueFields: Array<keyof S & string>;
  autoIncrementFields: Array<keyof S & string>;
  primaryKey?: keyof S & string;
  signature: string;
}

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function resolveSchema<S extends SchemaDefinition>(
  tableName: string,
  schema: S
): ResolvedSchema<S> {
  if (!identifierPattern.test(tableName)) {
    throw new SchemaError(`Invalid table name "${tableName}". Use letters, numbers and underscores, starting with a letter or underscore.`);
  }

  const fieldNames = Object.keys(schema) as Array<keyof S & string>;
  if (fieldNames.length === 0) {
    throw new SchemaError(`Table "${tableName}" must have at least one field.`);
  }

  const fields = {} as Record<keyof S & string, ResolvedField>;
  const indexedFields: Array<keyof S & string> = [];
  const uniqueFields: Array<keyof S & string> = [];
  const autoIncrementFields: Array<keyof S & string> = [];
  let primaryKey: (keyof S & string) | undefined;

  for (const name of fieldNames) {
    if (!identifierPattern.test(name)) {
      throw new SchemaError(`Invalid field name "${name}" in table "${tableName}".`);
    }

    const builder = schema[name];
    if (!builder || typeof builder.toMeta !== "function") {
      throw new SchemaError(`Field "${name}" in table "${tableName}" is not a field builder.`);
    }

    const meta = builder.toMeta();

    if (meta.autoIncrement && meta.type !== "int") {
      throw new SchemaError(`Field "${tableName}.${name}" uses autoIncrement but is not an int field.`);
    }

    if (meta.autoIncrement && !meta.primary) {
      throw new SchemaError(`Field "${tableName}.${name}" uses autoIncrement and must also be primary.`);
    }

    if (meta.autoIncrement && meta.hasDefault) {
      throw new SchemaError(`Field "${tableName}.${name}" cannot combine autoIncrement with default().`);
    }

    if (meta.primary) {
      if (primaryKey) {
        throw new SchemaError(`Table "${tableName}" has more than one primary key.`);
      }
      if (meta.nullable) {
        throw new SchemaError(`Primary key "${tableName}.${name}" cannot be nullable.`);
      }
      primaryKey = name;
      meta.unique = true;
      meta.indexed = true;
    }

    if (meta.unique) {
      meta.indexed = true;
      uniqueFields.push(name);
    }

    if (meta.indexed) {
      indexedFields.push(name);
    }

    if (meta.autoIncrement) {
      autoIncrementFields.push(name);
    }

    fields[name] = {
      name,
      meta
    };
  }

  const signature = JSON.stringify(fieldNames.map((name) => {
    const meta = fields[name].meta;
    return [
      name,
      meta.type,
      meta.nullable,
      meta.primary,
      meta.autoIncrement,
      meta.unique,
      meta.indexed,
      meta.hasDefault
    ];
  }));

  return {
    tableName,
    fields,
    fieldNames,
    indexedFields,
    uniqueFields,
    autoIncrementFields,
    ...(primaryKey ? { primaryKey } : {}),
    signature
  };
}
