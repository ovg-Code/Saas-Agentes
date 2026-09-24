#!/usr/bin/env node
// En desarrollo ejecuta el TypeScript directamente con tsx; compilado usa dist/.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/main.js", import.meta.url));
if (existsSync(dist)) {
  await import(dist);
} else {
  const { register } = await import("tsx/esm/api");
  register();
  await import("../src/main.ts");
}
