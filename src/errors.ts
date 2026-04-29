export class DatabaseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SchemaError extends DatabaseError {}

export class ValidationError extends DatabaseError {}

export class UniqueConstraintError extends DatabaseError {}

export class PrimaryKeyError extends DatabaseError {}

export class NotFoundError extends DatabaseError {}

export class StorageError extends DatabaseError {}

export class QueryError extends DatabaseError {}
