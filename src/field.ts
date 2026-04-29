import type { DefaultProvider, FieldType, FieldValue } from "./types.js";

export interface FieldMeta {
  type: FieldType;
  nullable: boolean;
  primary: boolean;
  autoIncrement: boolean;
  unique: boolean;
  indexed: boolean;
  hasDefault: boolean;
  defaultValue?: DefaultProvider<unknown>;
}

export class FieldBuilder<
  TType extends FieldType,
  TNullable extends boolean = false,
  THasDefault extends boolean = false,
  TPrimary extends boolean = false,
  TAutoIncrement extends boolean = false
> {
  declare readonly __fieldType: TType;
  declare readonly __nullable: TNullable;
  declare readonly __hasDefault: THasDefault;
  declare readonly __primary: TPrimary;
  declare readonly __autoIncrement: TAutoIncrement;

  private readonly meta: FieldMeta;

  constructor(meta: FieldMeta) {
    this.meta = Object.freeze({ ...meta });
  }

  primary(): FieldBuilder<TType, false, THasDefault, true, TAutoIncrement> {
    return this.clone({
      primary: true,
      nullable: false,
      unique: true,
      indexed: true
    }) as FieldBuilder<TType, false, THasDefault, true, TAutoIncrement>;
  }

  autoIncrement(
    this: FieldBuilder<"int", TNullable, THasDefault, TPrimary, TAutoIncrement>
  ): FieldBuilder<"int", TNullable, THasDefault, TPrimary, true> {
    return this.clone({
      autoIncrement: true,
      indexed: true,
      unique: true
    }) as FieldBuilder<"int", TNullable, THasDefault, TPrimary, true>;
  }

  unique(): FieldBuilder<TType, TNullable, THasDefault, TPrimary, TAutoIncrement> {
    return this.clone({
      unique: true,
      indexed: true
    }) as FieldBuilder<TType, TNullable, THasDefault, TPrimary, TAutoIncrement>;
  }

  index(): FieldBuilder<TType, TNullable, THasDefault, TPrimary, TAutoIncrement> {
    return this.clone({
      indexed: true
    }) as FieldBuilder<TType, TNullable, THasDefault, TPrimary, TAutoIncrement>;
  }

  required(): FieldBuilder<TType, false, THasDefault, TPrimary, TAutoIncrement> {
    return this.clone({
      nullable: false
    }) as FieldBuilder<TType, false, THasDefault, TPrimary, TAutoIncrement>;
  }

  nullable(): FieldBuilder<TType, true, THasDefault, TPrimary, TAutoIncrement> {
    return this.clone({
      nullable: true
    }) as FieldBuilder<TType, true, THasDefault, TPrimary, TAutoIncrement>;
  }

  default(
    value: DefaultProvider<FieldValue<TType>>
  ): FieldBuilder<TType, TNullable, true, TPrimary, TAutoIncrement> {
    return this.clone({
      hasDefault: true,
      defaultValue: value as DefaultProvider<unknown>
    }) as FieldBuilder<TType, TNullable, true, TPrimary, TAutoIncrement>;
  }

  toMeta(): FieldMeta {
    return { ...this.meta };
  }

  private clone(overrides: Partial<FieldMeta>): FieldBuilder<FieldType, boolean, boolean, boolean, boolean> {
    return new FieldBuilder({
      ...this.meta,
      ...overrides
    });
  }
}

function createField<TType extends FieldType>(type: TType): FieldBuilder<TType> {
  return new FieldBuilder<TType>({
    type,
    nullable: false,
    primary: false,
    autoIncrement: false,
    unique: false,
    indexed: false,
    hasDefault: false
  });
}

export const field = {
  int: () => createField("int"),
  real: () => createField("real"),
  string: () => createField("string"),
  blob: () => createField("blob"),
  datetime: () => createField("datetime"),
  boolean: () => createField("boolean"),
  json: () => createField("json")
};
