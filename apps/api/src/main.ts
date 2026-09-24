import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { DirectRuntime, TemporalRuntime } from "./modules/conversations/index.js";
import { createDb } from "./shared/db.js";

const cfg = loadConfig();
const db = createDb(cfg.databaseUrl, cfg.databaseAdminUrl);
const direct = new DirectRuntime(cfg.runtimeUrl, cfg.internalToken);
const runtime =
  cfg.runtimeMode === "temporal"
    ? new TemporalRuntime({ address: cfg.temporalAddress, namespace: cfg.temporalNamespace, taskQueue: cfg.temporalTaskQueue }, direct)
    : direct;

const app = buildApp({
  db,
  runtime,
  templatesDir: cfg.templatesDir,
  vaultMasterKey: cfg.vaultMasterKey,
  platformAdminToken: cfg.platformAdminToken,
  internalToken: cfg.internalToken,
  publicBaseUrl: cfg.publicBaseUrl,
  logger: true,
});

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: cfg.port, host: "0.0.0.0" });
