import pg from "pg";

/**
 * Dos pools con responsabilidades distintas:
 *  - app:   rol agentes_app, sujeto a RLS. TODO acceso a datos de un tenant pasa por `withTenant`.
 *  - admin: rol propietario. Solo para operaciones de plataforma que cruzan tenants
 *           (crear tenant, resolver una API key a su tenant). Se usa en muy pocos sitios y a propósito.
 */
export interface Db {
  app: pg.Pool;
  admin: pg.Pool;
  withTenant<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDb(appUrl: string, adminUrl: string): Db {
  const app = new pg.Pool({ connectionString: appUrl, max: 20 });
  const admin = new pg.Pool({ connectionString: adminUrl, max: 4 });
  return {
    app,
    admin,
    async withTenant(tenantId, fn) {
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await Promise.all([app.end(), admin.end()]);
    },
  };
}
