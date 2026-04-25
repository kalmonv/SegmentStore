import { DatabaseError, SchemaError } from "./errors.js";
import { resolveSchema } from "./schema.js";
import {
  SegmentedStorageEngine,
  type SegmentedStorageEngineOptions
} from "./storage/segmented-storage-engine.js";
import type {
  DatabaseSnapshot,
  StorageEngine,
  TableMutation,
  TableSnapshot
} from "./storage/storage-engine.js";
import {
  applyTableMutationToSnapshot,
  cloneDatabaseSnapshot,
  createEmptySnapshot
} from "./storage/storage-engine.js";
import { Table } from "./table.js";
import type { SchemaDefinition } from "./types.js";

export type StorageMode = "segmented";

export interface DatabaseOpenOptions extends SegmentedStorageEngineOptions {
  storageMode?: StorageMode;
}

export class Database {
  private readonly storage: StorageEngine;
  private snapshot: DatabaseSnapshot;
  private readonly tables = new Map<string, Table<SchemaDefinition>>();
  private readonly tableSignatures = new Map<string, string>();
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(storage: StorageEngine, snapshot: DatabaseSnapshot) {
    this.storage = storage;
    this.snapshot = snapshot;
  }

  static async open(filePath: string, options: DatabaseOpenOptions = {}): Promise<Database> {
    if (options.storageMode !== undefined && options.storageMode !== "segmented") {
      throw new DatabaseError('Only storageMode "segmented" is supported.');
    }

    const storageOptions: SegmentedStorageEngineOptions = {};
    if (options.lockTimeoutMs !== undefined) {
      storageOptions.lockTimeoutMs = options.lockTimeoutMs;
    }
    if (options.staleLockMs !== undefined) {
      storageOptions.staleLockMs = options.staleLockMs;
    }
    if (options.segmentSize !== undefined) {
      storageOptions.segmentSize = options.segmentSize;
    }
    if (options.password !== undefined) {
      storageOptions.password = options.password;
    }

    const storage = new SegmentedStorageEngine(filePath, storageOptions);
    const snapshot = await storage.load();
    return new Database(storage, snapshot);
  }

  table<S extends SchemaDefinition>(name: string, schema: S): Table<S> {
    this.assertOpen();

    const resolved = resolveSchema(name, schema);
    const existingSignature = this.tableSignatures.get(name);
    const existingTable = this.tables.get(name);

    if (existingTable && existingSignature === resolved.signature) {
      return existingTable as Table<S>;
    }

    if (existingTable) {
      throw new SchemaError(`Table "${name}" is already registered with a different schema.`);
    }

    const tableSnapshot = this.snapshot.tables[name];
    const table = new Table(this, name, schema, tableSnapshot);
    this.tables.set(name, table as Table<SchemaDefinition>);
    this.tableSignatures.set(name, resolved.signature);
    return table;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    await this.enqueueWrite(async () => {
      for (const table of this.tables.values()) {
        if (table.isLoaded()) {
          this.snapshot.tables[table.name] = table.createSnapshot();
        }
      }
      await this.storage.save(this.snapshot);
      await this.storage.close?.();
      this.closed = true;
    });
  }

  assertOpen(): void {
    if (this.closed) {
      throw new DatabaseError("Database is closed.");
    }
  }

  async persistTable(name: string, tableSnapshot: TableSnapshot): Promise<void> {
    await this.persistTableMutation(name, {
      type: "setTable",
      snapshot: tableSnapshot
    }, () => tableSnapshot);
  }

  async persistTableMutation(
    name: string,
    mutation: TableMutation,
    tableSnapshotFactory: () => TableSnapshot
  ): Promise<void> {
    this.assertOpen();
    await this.enqueueWrite(async () => {
      if (this.storage.appendTableMutation) {
        const nextSnapshot = applyTableMutationToSnapshot(this.snapshot, name, mutation);
        await this.storage.appendTableMutation(name, mutation);
        this.snapshot = nextSnapshot;
        return;
      }

      const tableSnapshot = tableSnapshotFactory();
      const nextSnapshot = cloneDatabaseSnapshot(this.snapshot);
      nextSnapshot.tables[name] = tableSnapshot;
      if (this.storage.saveTable) {
        await this.storage.saveTable(name, tableSnapshot);
        this.snapshot = nextSnapshot;
        return;
      }

      await this.storage.save(nextSnapshot);
      this.snapshot = nextSnapshot;
    });
  }

  async loadTableSnapshot(name: string): Promise<TableSnapshot> {
    this.assertOpen();

    const existing = this.snapshot.tables[name];
    if (existing) {
      return existing;
    }

    const loaded = await this.storage.loadTable?.(name);
    const tableSnapshot = loaded ?? createEmptyTableSnapshot();
    this.snapshot.tables[name] = tableSnapshot;
    return tableSnapshot;
  }

  private async enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(task, task);
    this.writeQueue = next.catch(() => undefined);
    await next;
  }
}

function createEmptyTableSnapshot(): TableSnapshot {
  return {
    rows: [],
    autoIncrement: {}
  };
}

export function createMemorySnapshot(): DatabaseSnapshot {
  return createEmptySnapshot();
}
