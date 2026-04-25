import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  Database,
  SegmentedStorageEngine,
  UniqueConstraintError
} from "../src/index.js";
import { createTempDb, userSchema } from "./helpers.js";

describe("SegmentedStorageEngine", () => {
  it("opens without hydrating table rows and loads table segments on demand", async () => {
    const temp = await createTempDb();
    const directoryPath = path.join(path.dirname(temp.filePath), "segmented-db");

    try {
      const db = await Database.open(directoryPath, {
        storageMode: "segmented",
        segmentSize: 2
      });
      const users = db.table("users", userSchema());

      for (let index = 0; index < 5; index += 1) {
        await users.insert({
          name: `User ${index}`,
          email: `user${index}@example.com`,
          age: 20 + index
        });
      }

      await db.close();

      const engine = new SegmentedStorageEngine(directoryPath, { segmentSize: 2 });
      const openSnapshot = await engine.load();
      expect(openSnapshot.tables).toEqual({});

      const loadedUsers = await engine.loadTable("users");
      expect(loadedUsers?.rows).toHaveLength(5);

      const meta = JSON.parse(await readFile(
        path.join(directoryPath, "tables", "users", "meta.json"),
        "utf8"
      )) as { activeGeneration: number };
      const segmentFiles = await readdir(path.join(
        directoryPath,
        "tables",
        "users",
        "generations",
        String(meta.activeGeneration),
        "segments"
      ));

      expect(segmentFiles.filter((file) => file.endsWith(".json"))).toHaveLength(3);
    } finally {
      await temp.cleanup();
    }
  });

  it("persists updates/deletes and rebuilds indexes after lazy load", async () => {
    const temp = await createTempDb();
    const directoryPath = path.join(path.dirname(temp.filePath), "segmented-db");

    try {
      const db = await Database.open(directoryPath, {
        storageMode: "segmented",
        segmentSize: 2
      });
      const users = db.table("users", userSchema());

      await users.insert({ name: "Ana", email: "ana@example.com", age: 25 });
      await users.insert({ name: "Bob", email: "bob@example.com", age: 30 });
      await users.update({ email: "ana@example.com" }, { email: "ana.new@example.com", age: 26 });
      await users.delete({ email: "bob@example.com" });
      await db.close();

      const reopened = await Database.open(directoryPath, {
        storageMode: "segmented",
        segmentSize: 2
      });
      const reopenedUsers = reopened.table("users", userSchema());

      await expect(reopenedUsers.find()).resolves.toMatchObject([
        {
          id: 1,
          name: "Ana",
          email: "ana.new@example.com",
          age: 26
        }
      ]);

      await expect(reopenedUsers.insert({
        name: "Duplicate",
        email: "ana.new@example.com"
      })).rejects.toBeInstanceOf(UniqueConstraintError);

      await reopened.close();
    } finally {
      await temp.cleanup();
    }
  });

  it("encrypts segmented files when opened with a password", async () => {
    const temp = await createTempDb();
    const directoryPath = path.join(path.dirname(temp.filePath), "encrypted-segmented-db");
    const password = "correct horse battery staple";

    try {
      const db = await Database.open(directoryPath, {
        storageMode: "segmented",
        segmentSize: 2,
        password
      });
      const users = db.table("users", userSchema());

      await users.insert({ name: "Ana", email: "ana@example.com", age: 25 });
      await db.close();

      const manifestContents = await readFile(path.join(directoryPath, "manifest.json"), "utf8");
      const segmentContents = await readFile(
        path.join(directoryPath, "tables", "users", "generations", "2", "segments", "000000.json"),
        "utf8"
      );

      expect(manifestContents).toContain("encrypted-json");
      expect(segmentContents).toContain("encrypted-json");
      expect(segmentContents).not.toContain("ana@example.com");

      await expect(Database.open(directoryPath)).rejects.toThrow(/encrypted.*password/i);
      await expect(Database.open(directoryPath, {
        storageMode: "segmented",
        password: "wrong password"
      })).rejects.toThrow(/Failed to decrypt/);

      const reopened = await Database.open(directoryPath, {
        storageMode: "segmented",
        password
      });
      const reopenedUsers = reopened.table("users", userSchema());

      await expect(reopenedUsers.find({ email: "ana@example.com" })).resolves.toMatchObject([
        { name: "Ana", age: 25 }
      ]);

      await reopened.close();
    } finally {
      await temp.cleanup();
    }
  });
});
