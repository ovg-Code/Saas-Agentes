import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type pg from "pg";
import { notFound } from "../../shared/errors.js";

/**
 * Bóveda mínima de credenciales por tenant (AES-256-GCM, clave maestra fuera de la BD).
 * Interfaz pensada para sustituirse por HashiCorp Vault / KMS / Nango sin tocar el resto:
 * fuera de este módulo solo circulan referencias `vault://<tenant>/<nombre>`.
 */
export class Vault {
  constructor(private readonly masterKey: Buffer) {}

  static ref(tenantSlug: string, name: string): string {
    return `vault://${tenantSlug}/${name}`;
  }

  static parseRef(ref: string): { tenantSlug: string; name: string } {
    const m = /^vault:\/\/([^/]+)\/(.+)$/.exec(ref);
    if (!m) throw notFound(`referencia de bóveda inválida: ${ref}`);
    return { tenantSlug: m[1]!, name: m[2]! };
  }

  encrypt(plaintext: string, aad: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
  }

  decrypt(row: { ciphertext: Buffer; iv: Buffer; tag: Buffer }, aad: string): string {
    const decipher = createDecipheriv("aes-256-gcm", this.masterKey, row.iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(row.tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
  }

  /** `c` debe ser una conexión con el tenant fijado (RLS). El AAD ata el cifrado al tenant+nombre. */
  async put(
    c: pg.PoolClient,
    tenantId: string,
    name: string,
    secret: string,
    meta: { kind?: "secret" | "oauth"; provider?: string; scopes?: string[]; expiresAt?: Date | null } = {},
  ): Promise<void> {
    const { ciphertext, iv, tag } = this.encrypt(secret, `${tenantId}:${name}`);
    await c.query(
      `INSERT INTO credentials (tenant_id, name, ciphertext, iv, tag, kind, provider, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv,
         tag = EXCLUDED.tag, kind = EXCLUDED.kind, provider = EXCLUDED.provider, scopes = EXCLUDED.scopes,
         expires_at = EXCLUDED.expires_at, needs_reconnect = false, rotated_at = now()`,
      [tenantId, name, ciphertext, iv, tag, meta.kind ?? "secret", meta.provider ?? null, meta.scopes ?? null, meta.expiresAt ?? null],
    );
  }

  async names(c: pg.PoolClient): Promise<string[]> {
    // Una conexión OAuth revocada no cuenta como disponible: el despliegue pedirá reconectar.
    const { rows } = await c.query("SELECT name FROM credentials WHERE NOT needs_reconnect ORDER BY name");
    return rows.map((r) => r.name);
  }

  async get(c: pg.PoolClient, tenantId: string, name: string): Promise<string> {
    const { rows } = await c.query("SELECT ciphertext, iv, tag FROM credentials WHERE name = $1", [name]);
    if (!rows[0]) throw notFound(`credencial '${name}' no encontrada`);
    return this.decrypt(rows[0], `${tenantId}:${name}`);
  }
}
