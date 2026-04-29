import { rm } from "node:fs/promises";
import { Database, field } from "../src/index.js";

const dbPath = "./data/examples/segmented.db";
const password = "senha-do-exemplo";
await rm(dbPath, { recursive: true, force: true });

const db = await Database.open(dbPath, {
  storageMode: "segmented",
  segmentSize: 2,
  password
});

const users = db.table("users", {
  id: field.int().primary().autoIncrement(),
  name: field.string().required(),
  email: field.string().unique().index(),
  age: field.int().default(0),
  active: field.boolean().default(true),
  createdAt: field.datetime().default(() => new Date())
});

for (let index = 0; index < 5; index += 1) {
  await users.insert({
    name: `User ${index}`,
    email: `user${index}@example.com`,
    age: 20 + index
  });
}

console.log("Segmented users:", await users.orderBy("age", "desc").limit(3).find());

await db.close();

const reopened = await Database.open(dbPath, {
  storageMode: "segmented",
  segmentSize: 2,
  password
});
const reopenedUsers = reopened.table("users", {
  id: field.int().primary().autoIncrement(),
  name: field.string().required(),
  email: field.string().unique().index(),
  age: field.int().default(0),
  active: field.boolean().default(true),
  createdAt: field.datetime().default(() => new Date())
});

console.log("After lazy table load:", await reopenedUsers.find({ email: "user3@example.com" }));

await reopened.close();
