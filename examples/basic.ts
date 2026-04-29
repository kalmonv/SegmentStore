import { rm } from "node:fs/promises";
import { Database, field } from "../src/index.js";

const dbPath = "./data/examples/basic.db";
const password = "senha-do-exemplo";
await rm(dbPath, { recursive: true, force: true });

const db = await Database.open(dbPath, {
  password
});

const users = db.table("users", {
  id: field.int().primary().autoIncrement(),
  name: field.string().required(),
  email: field.string().unique().index(),
  age: field.int().default(0),
  avatar: field.blob().nullable(),
  active: field.boolean().default(true),
  metadata: field.json().nullable(),
  createdAt: field.datetime().default(() => new Date())
});

const items = db.table("items", {
  id: field.int().primary().autoIncrement(),
  name: field.string().required(),
  ownerEmail: field.string().index(),
  price: field.real().default(0),
  metadata: field.json().nullable()
});

await users.insert({
  name: "Ana",
  email: "ana@example.com",
  age: 25,
  avatar: new Uint8Array([1, 2, 3]),
  metadata: { role: "admin", tags: ["demo", "json"] }
});

await users.insert({
  name: "Bruno",
  email: "bruno@example.com",
  age: 17,
  active: false
});

await users.insert({
  name: "Carla",
  email: "carla@example.com",
  age: 31
});

await items.insert({
  name: "Sword",
  ownerEmail: "ana@example.com",
  price: 99.9,
  metadata: { rarity: "rare" }
});

await items.insert({
  name: "Potion",
  ownerEmail: "carla@example.com",
  price: 12.5
});

const adults = await users
  .where("age", ">=", 18)
  .where("active", "=", true)
  .orderBy("createdAt", "desc")
  .limit(10)
  .offset(0)
  .find();

console.log("Adult users:", adults);

await users.where("age", "=", 25).update(
  { email: "ana@example.com" },
  { name: "Ana Maria", age: 26 }
);

console.log("Ana after update:", await users.find({ email: "ana@example.com" }));

await items.delete({ name: "Potion" });

console.log("Items after delete:", await items.orderBy("price", "desc").find());

await db.close();
