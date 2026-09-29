import { expect, test } from "bun:test";
import { databaseTransportProblem } from "../src/config.js";

test("remote production databases must verify the server certificate", () => {
  for (const url of [
    "postgresql://liege:pw@db.example.com:5432/liege",
    "postgresql://liege:pw@db.example.com/liege?sslmode=disable",
    "postgresql://liege:pw@db.example.com/liege?sslmode=prefer",
    "postgresql://liege:pw@db.example.com/liege?sslmode=require",
    "postgresql://liege:pw@db.example.com/liege?sslmode=no-verify",
  ])
    expect(databaseTransportProblem(url)).toContain("sslmode=verify-full");

  for (const url of [
    "postgresql://liege:pw@db.example.com/liege?sslmode=verify-full",
    "postgresql://liege:pw@db.example.com/liege?sslmode=verify-ca&sslrootcert=/etc/ca.pem",
    "postgresql://liege:pw@localhost:5432/liege",
    "postgresql://liege:pw@127.0.0.1/liege",
    "postgresql://liege:pw@[::1]/liege",
    "postgresql:///liege?host=/var/run/postgresql",
  ])
    expect(databaseTransportProblem(url)).toBeNull();
});
