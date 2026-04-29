import { describe, expect, it } from "vitest";
import { Database } from "../src/index.js";
import { createTempDb, userSchema } from "./helpers.js";

describe("Database", () => {
  it("creates a database file, persists rows and reopens with hydrated values", async () => {
    const temp = await createTempDb();

    try {
      const db = await Database.open(temp.filePath);
      const users = db.table("users", userSchema());

      const inserted = await users.insert({
        name: "Ana",
        email: "ana@example.com",
        avatar: new Uint8Array([1, 2, 3]),
        metadata: { role: "admin", tags: ["local"] }
      });

      expect(inserted).toMatchObject({
        id: 1,
        name: "Ana",
        email: "ana@example.com",
        age: 0,
        rating: 0,
        active: true,
        metadata: { role: "admin", tags: ["local"] }
      });
      expect(inserted.createdAt).toBeInstanceOf(Date);
      expect(inserted.avatar).toBeInstanceOf(Uint8Array);

      await db.close();

      const reopened = await Database.open(temp.filePath);
      const reopenedUsers = reopened.table("users", userSchema());
      const rows = await reopenedUsers.find({ email: "ana@example.com" });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.createdAt).toBeInstanceOf(Date);
      expect(rows[0]?.createdAt.toISOString()).toBe("2024-01-01T00:00:00.000Z");
      expect([...(rows[0]?.avatar ?? [])]).toEqual([1, 2, 3]);
      expect(rows[0]?.metadata).toEqual({ role: "admin", tags: ["local"] });

      await reopened.close();
    } finally {
      await temp.cleanup();
    }
  });

  it("returns the same table instance for the same schema and rejects incompatible re-registration", async () => {
    const temp = await createTempDb();

    try {
      const db = await Database.open(temp.filePath);
      const users = db.table("users", userSchema());

      expect(db.table("users", userSchema())).toBe(users);
      expect(() => db.table("users", {
        id: userSchema().id,
        email: userSchema().email
      })).toThrow(/different schema/);

      await db.close();
    } finally {
      await temp.cleanup();
    }
  });
});
