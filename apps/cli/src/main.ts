import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { type EvalCase, loadTemplateDir, SpecError, validateDeployment } from "@agentes/agent-spec";
import { parse as parseYaml } from "yaml";

const HELP = `agentes — despliega y prueba agentes de IA a partir de plantillas

Uso:
  agentes deploy <cliente.yaml> [--dry-run]     Despliega (o actualiza) un cliente en un paso
  agentes eval --agent <id> --template <dir>    Ejecuta las evals golden de la plantilla contra el agente
  agentes chat --agent <id> "<mensaje>"         Envía un mensaje (reutiliza --conversation <id>)
  agentes templates                             Lista las plantillas disponibles

Entorno:
  AGENTES_API_URL   (por defecto http://localhost:8080)
  AGENTES_TOKEN     token de plataforma o API key del tenant (deploy/eval/chat)
`;

type Args = { _: string[]; [k: string]: string | boolean | string[] };

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const API = (process.env.AGENTES_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
const c = { bold: (s: string) => `\x1b[1m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m` };

async function call<T>(method: string, path: string, token: string | undefined, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string; details?: { path: string; message: string }[] };
  if (!r.ok) {
    const details = data.details?.map((d) => `  - ${d.path}: ${d.message}`).join("\n");
    throw new Error(`${data.error ?? `HTTP ${r.status}`}${details ? `\n${details}` : ""}`);
  }
  return data;
}

async function readSource(source: string, baseDir: string): Promise<string> {
  if (source.startsWith("text:")) return source.slice(5);
  if (/^https?:\/\//.test(source)) {
    const r = await fetch(source);
    if (!r.ok) throw new Error(`no se pudo descargar ${source}: HTTP ${r.status}`);
    return r.text();
  }
  const path = isAbsolute(source) ? source : join(baseDir, source);
  if (!existsSync(path)) throw new Error(`no existe ${path}`);
  return readFileSync(path, "utf8");
}

// ------------------------------------------------------------------ deploy

async function deploy(args: Args) {
  const file = args._[1];
  if (!file) throw new Error("uso: agentes deploy <cliente.yaml>");
  const t0 = performance.now();
  const baseDir = dirname(resolve(file));
  const raw = parseYaml(readFileSync(file, "utf8"));
  const deployment = validateDeployment(raw); // falla rápido, antes de llamar a la API

  const connector_specs: Record<string, string> = {};
  for (const conn of deployment.connectors ?? []) {
    if (conn.type === "openapi" && conn.spec) connector_specs[conn.id] = await readSource(conn.spec, baseDir);
  }
  const secrets: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, src] of Object.entries(deployment.credentials ?? {})) {
    if (!src.from_env) continue;
    const v = process.env[src.from_env];
    if (v) secrets[name] = v;
    else missing.push(`${name} (variable ${src.from_env})`);
  }
  if (missing.length) console.log(c.yellow(`⚠ sin valor en el entorno: ${missing.join(", ")} — se usará lo que ya haya en la bóveda`));
  const knowledge = [];
  for (const k of deployment.knowledge ?? []) {
    knowledge.push({ source: k.source.startsWith("text:") ? `texto-${knowledge.length + 1}` : k.source, title: k.title ?? k.source, text: await readSource(k.source, baseDir) });
  }

  type Res = {
    tenant: { slug: string; created: boolean };
    agent: { id: string; name: string };
    release: { id: string; template: string; changed: boolean; autonomy: string };
    tools: { name: string; tier: string; approval: string; binding: string }[];
    knowledge: { source: string; chunks: number | null; error?: string }[];
    keys: Record<string, string>;
    endpoints: Record<string, string>;
    dry_run: boolean;
  };
  const res = await call<Res>("POST", "/v1/deploy", process.env.AGENTES_TOKEN, {
    deployment,
    connector_specs,
    secrets,
    knowledge,
    dry_run: Boolean(args["dry-run"]),
  });
  const secs = ((performance.now() - t0) / 1000).toFixed(1);

  console.log(`\n${c.green("✔")} ${c.bold(res.agent.name)} ${res.dry_run ? c.yellow("(dry-run, nada publicado)") : ""}`);
  console.log(`  cliente     ${res.tenant.slug}${res.tenant.created ? c.green(" (nuevo)") : ""}`);
  console.log(`  plantilla   ${res.release.template}   autonomía ${res.release.autonomy}`);
  console.log(`  release     ${res.release.id}${res.release.changed ? c.green(" (publicado)") : c.dim(" (sin cambios)")}`);
  console.log(`\n  ${c.bold("Tools")}`);
  for (const t of res.tools) console.log(`   ${t.approval === "ask" ? c.yellow("⏸") : "▶"} ${t.name.padEnd(24)} ${t.tier.padEnd(12)} ${c.dim(t.binding)}`);
  console.log(c.dim("   ⏸ = requiere aprobación humana"));
  if (res.knowledge.length) {
    console.log(`\n  ${c.bold("Conocimiento")}`);
    for (const k of res.knowledge) console.log(`   ${k.error ? c.red("✘") : "✔"} ${k.source} ${k.error ? c.red(k.error) : c.dim(`${k.chunks} fragmentos`)}`);
  }
  if (!res.dry_run) {
    console.log(`\n  ${c.bold("Integración")}`);
    console.log(`   API chat   POST ${res.endpoints.chat}`);
    console.log(`   MCP        ${res.endpoints.mcp}`);
    console.log(`   Consola    ${res.endpoints.console}`);
    console.log(`   Widget     ${res.endpoints.widget_snippet}`);
    if (Object.keys(res.keys).length) {
      console.log(`\n  ${c.bold("API keys")} ${c.yellow("(se muestran UNA sola vez, guárdalas)")}`);
      for (const [k, v] of Object.entries(res.keys)) console.log(`   ${k.padEnd(7)} ${v}`);
    }
  }
  console.log(c.dim(`\n  desplegado en ${secs}s`));
}

// ------------------------------------------------------------------ eval

interface ChatRes {
  conversation_id: string;
  status: string;
  reply: string;
  tools_executed: string[];
}

function check(turn: EvalCase["turns"][number], r: ChatRes): string[] {
  const e = turn.expect ?? {};
  const fails: string[] = [];
  const statusMap: Record<string, string> = { completed: "completed", awaiting_approval: "awaiting_approval", handoff: "handoff" };
  if (e.status && statusMap[e.status] !== r.status) fails.push(`estado ${r.status}, se esperaba ${e.status}`);
  for (const t of e.tools_called ?? []) if (!r.tools_executed.includes(t)) fails.push(`no ejecutó ${t}`);
  for (const t of e.tools_not_called ?? []) if (r.tools_executed.includes(t)) fails.push(`ejecutó ${t} y no debía`);
  for (const s of e.contains ?? []) if (!r.reply.toLowerCase().includes(s.toLowerCase())) fails.push(`la respuesta no contiene "${s}"`);
  for (const s of e.not_contains ?? []) if (r.reply.toLowerCase().includes(s.toLowerCase())) fails.push(`la respuesta contiene "${s}"`);
  return fails;
}

async function evals(args: Args) {
  const agent = String(args.agent ?? "");
  const dir = String(args.template ?? "");
  if (!agent || !dir) throw new Error("uso: agentes eval --agent <id> --template <dir de la plantilla>");
  const { template, evals: cases } = loadTemplateDir(dir);
  const token = process.env.AGENTES_TOKEN;
  let passed = 0;
  console.log(c.bold(`Evals de ${template.id}@${template.version} contra ${agent}\n`));
  for (const ec of cases) {
    let conversation: string | undefined;
    const fails: string[] = [];
    for (const turn of ec.turns) {
      const r = await call<ChatRes>("POST", `/v1/agents/${agent}/chat`, token, { message: turn.user, channel: "eval", ...(conversation ? { conversation_id: conversation } : {}) });
      conversation = r.conversation_id;
      fails.push(...check(turn, r));
    }
    if (fails.length === 0) passed++;
    console.log(`${fails.length ? c.red("✘") : c.green("✔")} ${ec.id} ${c.dim(ec.description ?? "")}`);
    for (const f of fails) console.log(`    ${c.red(f)}`);
  }
  console.log(`\n${passed}/${cases.length} casos superados`);
  if (passed !== cases.length) process.exitCode = 1;
}

// ------------------------------------------------------------------ chat / templates

async function chat(args: Args) {
  const agent = String(args.agent ?? "");
  const message = args._.slice(1).join(" ");
  if (!agent || !message) throw new Error('uso: agentes chat --agent <id> "mensaje"');
  const r = await call<ChatRes & { approvals: unknown[] }>("POST", `/v1/agents/${agent}/chat`, process.env.AGENTES_TOKEN, {
    message,
    ...(typeof args.conversation === "string" ? { conversation_id: args.conversation } : {}),
  });
  console.log(r.reply);
  console.log(c.dim(`\n[${r.status}] conversación ${r.conversation_id} · tools: ${r.tools_executed.join(", ") || "—"}`));
}

async function templates() {
  const r = await call<{ templates: { id: string; version: string; name: string; description?: string }[] }>("GET", "/v1/templates", undefined);
  for (const t of r.templates) console.log(`${c.bold(`${t.id}@${t.version}`)}  ${t.name}\n  ${c.dim(t.description ?? "")}`);
}

const args = parseArgs(process.argv.slice(2));
const commands: Record<string, (a: Args) => Promise<void>> = { deploy, eval: evals, chat, templates };
const cmd = commands[args._[0] ?? ""];
if (!cmd || args.help) {
  console.log(HELP);
  process.exit(cmd ? 0 : 1);
}
try {
  await cmd(args);
} catch (e) {
  console.error(c.red(`✘ ${e instanceof SpecError ? e.message : (e as Error).message}`));
  process.exit(1);
}
