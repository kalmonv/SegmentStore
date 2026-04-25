import type { FieldBuilder } from "./field.js";

export type FieldType =
  | "int"
  | "real"
  | "string"
  | "blob"
  | "datetime"
  | "boolean"
  | "json";

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export type BlobValue = Uint8Array;

export interface FieldTypeMap {
  int: number;
  real: number;
  string: string;
  blob: BlobValue;
  datetime: Date;
  boolean: boolean;
  json: JsonValue;
}

export type FieldValue<T extends FieldType> = FieldTypeMap[T];

export type DefaultProvider<T> = T | (() => T);

export type AnyField = FieldBuilder<FieldType, boolean, boolean, boolean, boolean>;

export type SchemaDefinition = Record<string, AnyField>;

export type FieldTypeOf<F> =
  F extends FieldBuilder<infer TType, boolean, boolean, boolean, boolean>
    ? TType
    : never;

export type FieldNullableOf<F> =
  F extends FieldBuilder<FieldType, infer TNullable, boolean, boolean, boolean>
    ? TNullable
    : never;

export type FieldHasDefaultOf<F> =
  F extends FieldBuilder<FieldType, boolean, infer THasDefault, boolean, boolean>
    ? THasDefault
    : never;

export type FieldPrimaryOf<F> =
  F extends FieldBuilder<FieldType, boolean, boolean, infer TPrimary, boolean>
    ? TPrimary
    : never;

export type FieldAutoIncrementOf<F> =
  F extends FieldBuilder<FieldType, boolean, boolean, boolean, infer TAutoIncrement>
    ? TAutoIncrement
    : never;

export type FieldRuntimeValue<F> =
  FieldValue<FieldTypeOf<F>> |
  (FieldNullableOf<F> extends true ? null : never);

type InsertRequiredKeys<S extends SchemaDefinition> = {
  [K in keyof S]:
    FieldAutoIncrementOf<S[K]> extends true
      ? never
      : FieldHasDefaultOf<S[K]> extends true
        ? never
        : FieldNullableOf<S[K]> extends true
          ? never
          : K;
}[keyof S];

type InsertOptionalKeys<S extends SchemaDefinition> = Exclude<keyof S, InsertRequiredKeys<S>>;

type UpdatableKeys<S extends SchemaDefinition> = {
  [K in keyof S]: FieldPrimaryOf<S[K]> extends true ? never : K;
}[keyof S];

type Expand<T> = { [K in keyof T]: T[K] } & {};

export type RowOf<S extends SchemaDefinition> = Expand<{
  [K in keyof S]: FieldRuntimeValue<S[K]>;
}>;

export type InsertInput<S extends SchemaDefinition> = Expand<
  {
    [K in InsertRequiredKeys<S>]: FieldRuntimeValue<S[K]>;
  } & {
    [K in InsertOptionalKeys<S>]?: FieldRuntimeValue<S[K]>;
  }
>;

export type UpdateInput<S extends SchemaDefinition> = Expand<Partial<{
  [K in UpdatableKeys<S>]: FieldRuntimeValue<S[K]>;
}>>;

export type WhereInput<S extends SchemaDefinition> = Expand<Partial<{
  [K in keyof S]: FieldRuntimeValue<S[K]>;
}>>;

export type ComparisonOperator =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "in"
  | "contains";

export type OrderDirection = "asc" | "desc";

export interface QueryCondition<S extends SchemaDefinition = SchemaDefinition> {
  field: keyof S & string;
  operator: ComparisonOperator;
  value: unknown;
}

export interface QueryOrder<S extends SchemaDefinition = SchemaDefinition> {
  field: keyof S & string;
  direction: OrderDirection;
}
