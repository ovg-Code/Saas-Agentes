import { readFileSync } from "node:fs";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { authenticate, bearer, type Principal } from "./shared/auth.js";
import type { Db } from "./shared/db.js";
import { badRequest, forbidden, HttpError } from "./shared/errors.js";
import { handleMcp } from "./modules/channels/mcp.js";
import { WebhookDispatcher } from "./modules/channels/webhooks.js";
import { ConversationService, type RuntimeGateway } from "./modules/conversations/index.js";
import { type DeployRequest, DeploymentService } from "./modules/deployments/index.js";
import { registerInternalRoutes } from "./modules/internal/index.js";
import { TemplateCatalog } from "./modules/templates/index.js";
import { Vault } from "./modules/vault/index.js";

export interface AppDeps {
  db: Db;
  runtime: RuntimeGateway;
  templatesDir: string;
  vaultMasterKey: Buffer;
  platformAdminToken: string;
  internalToken: string;
  publicBaseUrl: string;
  webhooks?: WebhookDispatcher;
  logger?: boolean;
}

const asset = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 10 * 1024 * 1024 });
  const vault = new Vault(deps.vaultMasterKey);
  const templates = new TemplateCatalog(deps.templatesDir);
  const conversations = new ConversationService(deps.db, deps.runtime, vault, deps.webhooks ?? new WebhookDispatcher());
  const deployments = new DeploymentService(deps.db, templates, vault, deps.runtime, deps.publicBaseUrl);

  // El widget se embebe en webs de clientes: CORS abierto solo para chat.
  void app.register(cors, {
    origin: true,
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "x-api-key"],
  });

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ error: error.message, ...(error.details ? { details: error.details } : {}) });
    }
    if (error.validation) return reply.status(400).send({ error: error.message });
    app.log.error(error);
    return reply.status(500).send({ error: "error interno" });
  });

  const principal = (req: FastifyRequest): Promise<Principal> => authenticate(deps.db, deps.platformAdminToken, bearer(req));
  const tenantScope = (p: Principal, query: { tenant_id?: string }): string => {
    if (p.kind === "platform") {
      if (!query.tenant_id) throw badRequest("la plataforma debe indicar ?tenant_id=");
      return query.tenant_id;
    }
    if (p.kind !== "admin") throw forbidden("se requiere una API key de administración");
    return p.tenantId;
  };

  // ---------------------------------------------------------------- salud y estáticos
  app.get("/health", async () => ({ ok: true, runtime: deps.runtime.mode }));
  app.get("/widget.js", async (_req, reply) => reply.type("application/javascript").header("cache-control", "public, max-age=300").send(asset("widget.js")));
  app.get("/console", async (_req, reply) => reply.type("text/html").send(asset("console.html")));

  // ---------------------------------------------------------------- plantillas (capa 1)
  app.get("/v1/templates", async () => ({ templates: templates.list() }));
  app.get<{ Params: { id: string } }>("/v1/templates/:id", async (req) => templates.describe(req.params.id));

  // ---------------------------------------------------------------- despliegue (capas 2-4)
  app.post<{ Body: DeployRequest }>("/v1/deploy", async (req, reply) => {
    const res = await deployments.deploy(await principal(req), req.body);
    return reply.status(res.dry_run ? 200 : res.release.changed ? 201 : 200).send(res);
  });
  app.get<{ Querystring: { tenant_id?: string } }>("/v1/agents", async (req) => {
    const p = await principal(req);
    return { agents: await deployments.listAgents(p, tenantScope(p, req.query)) };
  });
  app.get<{ Params: { id: string }; Querystring: { tenant_id?: string } }>("/v1/agents/:id/releases", async (req) => {
    const p = await principal(req);
    return { releases: await deployments.listReleases(p, tenantScope(p, req.query), req.params.id) };
  });
  app.post<{ Params: { id: string }; Body: { release_id: string }; Querystring: { tenant_id?: string } }>(
    "/v1/agents/:id/activate",
    async (req) => {
      const p = await principal(req);
      return deployments.activate(p, tenantScope(p, req.query), req.params.id, req.body.release_id);
    },
  );

  // ---------------------------------------------------------------- canales de entrada
  app.post<{ Params: { id: string }; Body: { message: string; conversation_id?: string; user?: string; channel?: string } }>(
    "/v1/agents/:id/chat",
    async (req) => conversations.sendMessage(await principal(req), req.params.id, req.body),
  );

  app.post<{ Params: { id: string }; Body: Parameters<typeof handleMcp>[3] }>("/v1/agents/:id/mcp", async (req, reply) => {
    const p = await principal(req);
    const tenantId = await conversations.tenantOfAgent(p, req.params.id);
    const agent = await conversations.agentInfo(tenantId, req.params.id);
    const res = await handleMcp(conversations, p, agent, req.body);
    return res === null ? reply.status(202).send() : reply.send(res);
  });

  // ---------------------------------------------------------------- operación humana
  app.get<{ Querystring: { tenant_id?: string; agent_id?: string } }>("/v1/conversations", async (req) => {
    const p = await principal(req);
    return { conversations: await conversations.list(p, tenantScope(p, req.query), req.query.agent_id) };
  });
  app.get<{ Params: { id: string } }>("/v1/conversations/:id", async (req) => conversations.get(await principal(req), req.params.id));
  app.post<{ Params: { id: string }; Body: { text: string; resume_bot?: boolean; by?: string } }>(
    "/v1/conversations/:id/human-reply",
    async (req) => {
      if (!req.body?.text) throw badRequest("'text' es obligatorio");
      return conversations.humanReply(await principal(req), req.params.id, req.body.text, Boolean(req.body.resume_bot), req.body.by ?? "equipo");
    },
  );
  app.get<{ Querystring: { tenant_id?: string; status?: string } }>("/v1/approvals", async (req) => {
    const p = await principal(req);
    return { approvals: await conversations.listApprovals(p, tenantScope(p, req.query), req.query.status) };
  });
  app.post<{ Params: { id: string }; Body: { approve: boolean; by?: string; note?: string } }>("/v1/approvals/:id", async (req) => {
    if (typeof req.body?.approve !== "boolean") throw badRequest("'approve' (boolean) es obligatorio");
    return conversations.decideApproval(await principal(req), req.params.id, req.body.approve, req.body.by ?? "equipo", req.body.note);
  });

  registerInternalRoutes(app, { db: deps.db, vault, conversations, internalToken: deps.internalToken });
  return app;
}
