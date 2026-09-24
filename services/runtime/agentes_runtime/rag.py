"""Base de conocimiento por agente: troceado, embeddings y búsqueda en pgvector (con RLS por tenant)."""

from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from typing import Protocol

import httpx
from psycopg_pool import AsyncConnectionPool

from .db import tenant_tx


class Embedder(Protocol):
    dim: int

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in text if not unicodedata.combining(c))


_STOP = set("el la los las un una unos unas de del al a y o que en con por para es son se su sus lo le les mi tu "
            "the of and to in is for on".split())


class HashingEmbedder:
    """Embeddings léxicos deterministas (hashing trick). Sin red ni coste: desarrollo y CI.

    Capturan solapamiento de palabras (con prefijos para tolerar plurales/conjugaciones), no semántica.
    En producción se usa GatewayEmbedder.
    """

    def __init__(self, dim: int = 1024):
        self.dim = dim

    def _features(self, text: str) -> list[str]:
        words = [w for w in re.findall(r"[a-z0-9]+", _normalize(text)) if w not in _STOP and len(w) > 1]
        feats = list(words) + [w[:5] for w in words if len(w) > 5]
        feats += [f"{a}_{b}" for a, b in zip(words, words[1:])]
        return feats

    async def embed(self, texts: list[str]) -> list[list[float]]:
        out = []
        for text in texts:
            vec = [0.0] * self.dim
            for f in self._features(text):
                h = int.from_bytes(hashlib.blake2b(f.encode(), digest_size=8).digest(), "big")
                vec[h % self.dim] += 1.0 if (h >> 63) == 0 else -1.0
            norm = math.sqrt(sum(v * v for v in vec)) or 1.0
            out.append([v / norm for v in vec])
        return out


class GatewayEmbedder:
    """Embeddings vía el gateway (LiteLLM, endpoint /v1/embeddings compatible)."""

    def __init__(self, base_url: str, api_key: str, model: str, dim: int):
        self.dim = dim
        self._client = httpx.AsyncClient(base_url=base_url, headers={"Authorization": f"Bearer {api_key}"}, timeout=30)
        self._model = model

    async def embed(self, texts: list[str]) -> list[list[float]]:
        r = await self._client.post("/v1/embeddings", json={"model": self._model, "input": texts, "dimensions": self.dim})
        r.raise_for_status()
        return [d["embedding"] for d in sorted(r.json()["data"], key=lambda d: d["index"])]


def chunk_text(text: str, max_chars: int = 900) -> list[str]:
    """Trocea respetando secciones markdown y párrafos; cada trozo lleva su encabezado para dar contexto."""
    sections = re.split(r"\n(?=#{1,6}\s)", text.strip())
    chunks: list[str] = []
    for section in sections:
        lines = section.strip().splitlines()
        heading = lines[0].strip() if lines and lines[0].startswith("#") else ""
        body = "\n".join(lines[1:] if heading else lines).strip()
        current = ""
        for para in re.split(r"\n\s*\n", body):
            para = para.strip()
            if not para:
                continue
            if current and len(current) + len(para) + 2 > max_chars:
                chunks.append(f"{heading}\n{current}".strip())
                current = ""
            current = f"{current}\n\n{para}".strip()
        if current or heading:
            chunks.append(f"{heading}\n{current}".strip())
    return [c for c in chunks if c]


def _vec(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


class KnowledgeBase:
    def __init__(self, pool: AsyncConnectionPool, embedder: Embedder):
        self.pool = pool
        self.embedder = embedder

    async def ingest(self, tenant_id: str, agent_id: str, source: str, title: str, text: str) -> int:
        """Idempotente por (agente, source): reingestar un documento reemplaza sus trozos."""
        chunks = chunk_text(text)
        vectors = await self.embedder.embed(chunks) if chunks else []
        async with tenant_tx(self.pool, tenant_id) as conn:
            await conn.execute("DELETE FROM knowledge_documents WHERE agent_id = %s AND source = %s", (agent_id, source))
            cur = await conn.execute(
                "INSERT INTO knowledge_documents (tenant_id, agent_id, source, title) VALUES (%s, %s, %s, %s) RETURNING id",
                (tenant_id, agent_id, source, title))
            row = await cur.fetchone()
            assert row is not None
            doc_id = row[0]
            for content, vec in zip(chunks, vectors):
                await conn.execute(
                    "INSERT INTO knowledge_chunks (tenant_id, agent_id, document_id, content, embedding) "
                    "VALUES (%s, %s, %s, %s, %s::vector)", (tenant_id, agent_id, doc_id, content, _vec(vec)))
        return len(chunks)

    async def search(self, tenant_id: str, agent_id: str, query: str, k: int = 4, min_score: float = 0.05) -> list[dict]:
        [qvec] = await self.embedder.embed([query])
        async with tenant_tx(self.pool, tenant_id) as conn:
            cur = await conn.execute(
                """SELECT c.content, d.title, d.source, 1 - (c.embedding <=> %s::vector) AS score
                   FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
                   WHERE c.agent_id = %s
                   ORDER BY c.embedding <=> %s::vector LIMIT %s""",
                (_vec(qvec), agent_id, _vec(qvec), k))
            rows = await cur.fetchall()
        hits = [{"content": r[0], "title": r[1], "source": r[2], "score": round(float(r[3]), 4)} for r in rows]
        # Fragmentos sin relación con la consulta solo añaden ruido (y coste) al contexto del modelo.
        return [h for h in hits if h["score"] >= min_score]
