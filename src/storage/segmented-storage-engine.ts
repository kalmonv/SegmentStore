import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { StorageError } from "../errors.js";
import type { DatabaseSnapshot, StorageEngine, TableSnapshot } from "./storage-engine.js";
import { createEmptySnapshot } from "./storage-engine.js";

export interface SegmentedStorageEngineOptions {
  segmentSize?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  password?: string;
}

interface SegmentedManifest {
  version: 1;
  tables: string[];
}

interface TableMeta {
  version: 1;
  table: string;
  activeGeneration: number;
  rowCount: number;
  segmentSize: number;
  autoIncrement: Record<string, number>;
}

interface SegmentFile {
  version: 1;
  table: string;
  segment: number;
  rows: TableSnapshot["rows"];
}

interface EncryptedJsonFile {
  simpleLocalDb: "encrypted-json";
  version: 1;
  cipher: "aes-256-gcm";
  kdf: "scrypt";
  salt: string;
  iv: string;
  authTag: string;
  data: string;
}

const encryptionMarker = "simple-local-db/encrypted-json/v1";

export class SegmentedStorageEngine implements StorageEngine {
  private readonly directoryPath: string;
  private readonly tablesPath: string;
  private readonly manifestPath: string;
  private readonly lockPath: string;
  private readonly segmentSize: number;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly password: string | undefined;

  constructor(directoryPath: string, options: SegmentedStorageEngineOptions = {}) {
    this.directoryPath = path.resolve(directoryPath);
    this.tablesPath = path.join(this.directoryPath, "tables");
    this.manifestPath = path.join(this.directoryPath, "manifest.json");
    this.lockPath = path.join(this.directoryPath, ".write.lock");
    this.segmentSize = options.segmentSize ?? 1000;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.staleLockMs = options.staleLockMs ?? 30000;
    this.password = options.password;

    if (!Number.isInteger(this.segmentSize) || this.segmentSize <= 0) {
      throw new StorageError("segmentSize must be a positive integer.");
    }

    if (this.password !== undefined && this.password.length === 0) {
      throw new StorageError("password must not be empty.");
    }
  }

  async load(): Promise<DatabaseSnapshot> {
    await this.ensureRoot();
    return createEmptySnapshot();
  }

  async loadTable(tableName: string): Promise<TableSnapshot | undefined> {
    await this.ensureRoot();
    const tableDirectory = this.getTableDirectory(tableName);
    const meta = await this.readTableMeta(tableName);
    if (!meta) {
      return undefined;
    }

    const segmentsPath = path.join(
      tableDirectory,
      "generations",
      String(meta.activeGeneration),
      "segments"
    );

    let segmentFiles: string[];
    try {
      segmentFiles = await fs.readdir(segmentsPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new StorageError(`Active generation for table "${tableName}" is missing segments.`);
      }
      throw error;
    }

    const rows: TableSnapshot["rows"] = [];
    for (const fileName of segmentFiles
      .filter((file) => file.endsWith(".json"))
      .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10))) {
      const value = await this.readJsonIfExists(path.join(segmentsPath, fileName));
      const segment = validateSegmentFile(value, tableName);
      rows.push(...segment.rows);
    }

    return {
      rows: rows.slice(0, meta.rowCount),
      autoIncrement: { ...meta.autoIncrement }
    };
  }

  async saveTable(tableName: string, snapshot: TableSnapshot): Promise<void> {
    await this.ensureRoot();
    const release = await this.acquireLock();

    try {
      const tableDirectory = this.getTableDirectory(tableName);
      const previousMeta = await this.readTableMeta(tableName);
      const activeGeneration = (previousMeta?.activeGeneration ?? 0) + 1;
      const generationPath = path.join(tableDirectory, "generations", String(activeGeneration));
      const segmentsPath = path.join(generationPath, "segments");

      await fs.mkdir(segmentsPath, { recursive: true });

      const chunks = chunkRows(snapshot.rows, this.segmentSize);
      if (chunks.length === 0) {
        await this.writeJson(path.join(segmentsPath, "000000.json"), {
          version: 1,
          table: tableName,
          segment: 0,
          rows: []
        } satisfies SegmentFile);
      } else {
        for (let index = 0; index < chunks.length; index += 1) {
          await this.writeJson(path.join(segmentsPath, `${formatSegmentIndex(index)}.json`), {
            version: 1,
            table: tableName,
            segment: index,
            rows: chunks[index] ?? []
          } satisfies SegmentFile);
        }
      }

      await fsyncDirectory(segmentsPath);
      await fsyncDirectory(generationPath);

      await this.writeJson(path.join(tableDirectory, "meta.json"), {
        version: 1,
        table: tableName,
        activeGeneration,
        rowCount: snapshot.rows.length,
        segmentSize: this.segmentSize,
        autoIncrement: { ...snapshot.autoIncrement }
      } satisfies TableMeta);

      await this.addTableToManifest(tableName);
      await this.removeOldGenerations(tableName, activeGeneration);
      await fsyncDirectory(tableDirectory);
      await fsyncDirectory(this.directoryPath);
    } catch (error) {
      throw new StorageError(`Failed to save segmented table "${tableName}".`, {
        cause: error
      });
    } finally {
      await release();
    }
  }

  async save(snapshot: DatabaseSnapshot): Promise<void> {
    await this.ensureRoot();
    for (const [tableName, tableSnapshot] of Object.entries(snapshot.tables)) {
      await this.saveTable(tableName, tableSnapshot);
    }
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.tablesPath, { recursive: true });
    const manifest = await this.readJsonIfExists(this.manifestPath);
    if (manifest === undefined) {
      await this.writeJson(this.manifestPath, {
        version: 1,
        tables: []
      } satisfies SegmentedManifest);
    }
  }

  private async readTableMeta(tableName: string): Promise<TableMeta | undefined> {
    const value = await this.readJsonIfExists(path.join(this.getTableDirectory(tableName), "meta.json"));
    if (value === undefined) {
      return undefined;
    }

    return validateTableMeta(value, tableName);
  }

  private async addTableToManifest(tableName: string): Promise<void> {
    const current = validateManifest(await this.readJsonIfExists(this.manifestPath));
    if (current.tables.includes(tableName)) {
      return;
    }

    await this.writeJson(this.manifestPath, {
      version: 1,
      tables: [...current.tables, tableName].sort()
    } satisfies SegmentedManifest);
  }

  private async removeOldGenerations(tableName: string, activeGeneration: number): Promise<void> {
    const generationsPath = path.join(this.getTableDirectory(tableName), "generations");
    let entries: string[];
    try {
      entries = await fs.readdir(generationsPath);
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const generation = Number(entry);
      if (Number.isInteger(generation) && generation > 0 && generation < activeGeneration) {
        await fs.rm(path.join(generationsPath, entry), { recursive: true, force: true });
      }
    }));
  }

  private getTableDirectory(tableName: string): string {
    return path.join(this.tablesPath, tableName);
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await atomicWriteJson(filePath, value, this.password);
  }

  private async readJsonIfExists(filePath: string): Promise<unknown> {
    return readJsonIfExists(filePath, this.password);
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const startedAt = Date.now();

    while (true) {
      try {
        const handle = await fs.open(this.lockPath, "wx");
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString()
        }));
        await handle.close();
        return async () => {
          await fs.rm(this.lockPath, { force: true });
        };
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw new StorageError(`Failed to acquire write lock "${this.lockPath}".`, {
            cause: error
          });
        }

        await this.removeStaleLockIfNeeded();
        if (Date.now() - startedAt > this.lockTimeoutMs) {
          throw new StorageError(`Timed out waiting for database write lock "${this.lockPath}".`);
        }

        await delay(25);
      }
    }
  }

  private async removeStaleLockIfNeeded(): Promise<void> {
    try {
      const stat = await fs.stat(this.lockPath);
      if (Date.now() - stat.mtimeMs > this.staleLockMs) {
        await fs.rm(this.lockPath, { force: true });
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function validateManifest(value: unknown): SegmentedManifest {
  if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.tables)) {
    return {
      version: 1,
      tables: []
    };
  }

  return {
    version: 1,
    tables: value.tables.filter((table): table is string => typeof table === "string")
  };
}

function validateTableMeta(value: unknown, tableName: string): TableMeta {
  if (
    !isPlainObject(value) ||
    value.version !== 1 ||
    value.table !== tableName ||
    !isPositiveInteger(value.activeGeneration) ||
    !isNonNegativeInteger(value.rowCount) ||
    !isPositiveInteger(value.segmentSize) ||
    !isPlainObject(value.autoIncrement)
  ) {
    throw new StorageError(`Invalid metadata for segmented table "${tableName}".`);
  }

  return {
    version: 1,
    table: tableName,
    activeGeneration: value.activeGeneration,
    rowCount: value.rowCount,
    segmentSize: value.segmentSize,
    autoIncrement: validateAutoIncrement(value.autoIncrement, tableName)
  };
}

function validateSegmentFile(value: unknown, tableName: string): SegmentFile {
  if (
    !isPlainObject(value) ||
    value.version !== 1 ||
    value.table !== tableName ||
    !isNonNegativeInteger(value.segment) ||
    !Array.isArray(value.rows)
  ) {
    throw new StorageError(`Invalid segment file for table "${tableName}".`);
  }

  return {
    version: 1,
    table: tableName,
    segment: value.segment,
    rows: value.rows.map((row) => validateRow(row, tableName))
  };
}

function validateRow(value: unknown, tableName: string): TableSnapshot["rows"][number] {
  if (!isPlainObject(value)) {
    throw new StorageError(`Invalid row in segmented table "${tableName}".`);
  }

  return value as TableSnapshot["rows"][number];
}

function validateAutoIncrement(value: unknown, tableName: string): Record<string, number> {
  if (!isPlainObject(value)) {
    throw new StorageError(`Invalid autoIncrement map for table "${tableName}".`);
  }

  return Object.fromEntries(
    Object.entries(value).filter(([, counter]) => typeof counter === "number" && Number.isFinite(counter))
  ) as Record<string, number>;
}

function chunkRows(rows: TableSnapshot["rows"], size: number): TableSnapshot["rows"][] {
  const chunks: TableSnapshot["rows"][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function formatSegmentIndex(index: number): string {
  return index.toString().padStart(6, "0");
}

async function atomicWriteJson(filePath: string, value: unknown, password?: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  const handle = await fs.open(tmpPath, "w");
  try {
    const json = password === undefined
      ? `${JSON.stringify(value, null, 2)}\n`
      : `${JSON.stringify(encryptJson(value, password), null, 2)}\n`;
    await handle.writeFile(json, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await fs.rename(tmpPath, filePath);
  await fsyncDirectory(path.dirname(filePath));
}

async function readJsonIfExists(filePath: string, password?: string): Promise<unknown> {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    if (contents.trim().length === 0) {
      return undefined;
    }

    const parsed = JSON.parse(contents) as unknown;
    if (!isEncryptedJsonFile(parsed)) {
      return parsed;
    }

    if (password === undefined) {
      throw new StorageError(`File "${filePath}" is encrypted. Provide a password to open it.`);
    }

    return decryptJson(parsed, password, filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function encryptJson(value: unknown, password: string): EncryptedJsonFile {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveEncryptionKey(password, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(encryptionMarker, "utf8"));

  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ]);

  return {
    simpleLocalDb: "encrypted-json",
    version: 1,
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64")
  };
}

function decryptJson(file: EncryptedJsonFile, password: string, filePath: string): unknown {
  try {
    const salt = Buffer.from(file.salt, "base64");
    const iv = Buffer.from(file.iv, "base64");
    const authTag = Buffer.from(file.authTag, "base64");
    const encrypted = Buffer.from(file.data, "base64");
    const key = deriveEncryptionKey(password, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(encryptionMarker, "utf8"));
    decipher.setAuthTag(authTag);

    const plaintext = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);

    return JSON.parse(plaintext.toString("utf8"));
  } catch (error) {
    throw new StorageError(`Failed to decrypt "${filePath}". The password may be invalid or the file is corrupted.`, {
      cause: error
    });
  }
}

function deriveEncryptionKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32);
}

function isEncryptedJsonFile(value: unknown): value is EncryptedJsonFile {
  return (
    isPlainObject(value) &&
    value.simpleLocalDb === "encrypted-json" &&
    value.version === 1 &&
    value.cipher === "aes-256-gcm" &&
    value.kdf === "scrypt" &&
    typeof value.salt === "string" &&
    typeof value.iv === "string" &&
    typeof value.authTag === "string" &&
    typeof value.data === "string"
  );
}

async function fsyncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some platforms do not allow fsync on directories. File handles are still fsynced.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
