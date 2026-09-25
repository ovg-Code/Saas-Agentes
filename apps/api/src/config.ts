import { resolve } from "node:path";

export interface Config {
  port: number;
  publicBaseUrl: string;
  databaseUrl: string;
  databaseAdminUrl: string;
  runtimeMode: "direct" | "temporal";
  runtimeUrl: string;
  internalToken: string;
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
  vaultMasterKey: Buffer;
  platformAdminToken: string;
  templatesDir: string;
  whatsappApiBase: string;
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`falta la variable de entorno ${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const key = Buffer.from(required("VAULT_MASTER_KEY", env.VAULT_MASTER_KEY), "base64");
  if (key.length !== 32) throw new Error("VAULT_MASTER_KEY debe ser 32 bytes en base64 (openssl rand -base64 32)");
  const mode = env.RUNTIME_MODE ?? "direct";
  if (mode !== "direct" && mode !== "temporal") throw new Error("RUNTIME_MODE debe ser direct o temporal");
  return {
    port: Number(env.API_PORT ?? 8080),
    publicBaseUrl: env.PUBLIC_BASE_URL ?? `http://localhost:${env.API_PORT ?? 8080}`,
    databaseUrl: env.DATABASE_URL ?? "postgres://agentes_app:agentes_app@localhost:5432/agentes",
    databaseAdminUrl: env.DATABASE_ADMIN_URL ?? "postgres://agentes:agentes@localhost:5432/agentes",
    runtimeMode: mode,
    runtimeUrl: env.RUNTIME_URL ?? "http://localhost:8090",
    internalToken: env.INTERNAL_TOKEN ?? "dev-internal-token",
    temporalAddress: env.TEMPORAL_ADDRESS ?? "localhost:7233",
    temporalNamespace: env.TEMPORAL_NAMESPACE ?? "default",
    temporalTaskQueue: env.TEMPORAL_TASK_QUEUE ?? "agentes-runtime",
    vaultMasterKey: key,
    platformAdminToken: required("PLATFORM_ADMIN_TOKEN", env.PLATFORM_ADMIN_TOKEN),
    whatsappApiBase: env.WHATSAPP_API_BASE ?? "https://graph.facebook.com/v23.0",
    templatesDir: resolve(env.TEMPLATES_DIR ?? new URL("../../../templates", import.meta.url).pathname),
  };
}
