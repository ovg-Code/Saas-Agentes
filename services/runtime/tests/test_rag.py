import os

import psycopg
import pytest

from agentes_runtime.rag import HashingEmbedder, chunk_text


def test_chunking_respeta_secciones():
    text = "# FAQ\n\n## Envíos\nEnviamos en 24h.\n\n## Devoluciones\nTienes 30 días."
    chunks = chunk_text(text)
    assert any(c.startswith("## Envíos") and "24h" in c for c in chunks)
    assert any(c.startswith("## Devoluciones") and "30 días" in c for c in chunks)


async def test_embeddings_lexicos_ordenan_por_relevancia():
    e = HashingEmbedder(256)
    q, a, b = await e.embed(["plazo para devolver un producto", "Devoluciones: puedes devolver productos en 30 días",
                             "Formas de pago: tarjeta y Bizum"])
    cos = lambda x, y: sum(i * j for i, j in zip(x, y))  # noqa: E731 (vectores normalizados)
    assert cos(q, a) > cos(q, b)


DB = os.environ.get("TEST_DATABASE_URL")


@pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL no definido")
async def test_rls_aisla_el_conocimiento_entre_tenants():
    """Integración real con Postgres+pgvector y RLS (ver db/migrations)."""
    from agentes_runtime.db import close_pool, get_pool
    from agentes_runtime.rag import KnowledgeBase

    admin = os.environ["TEST_DATABASE_ADMIN_URL"]
    with psycopg.connect(admin, autocommit=True) as c:
        t1, t2 = (c.execute("INSERT INTO tenants (slug, name) VALUES (%s, %s) "
                            "ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id", (s, s)).fetchone()[0]
                  for s in ("rag-test-a", "rag-test-b"))
        a1, a2 = (c.execute("INSERT INTO agents (tenant_id, slug, name) VALUES (%s, 'bot', 'bot') ON CONFLICT (tenant_id, slug) "
                            "DO UPDATE SET name = EXCLUDED.name RETURNING id", (t,)).fetchone()[0] for t in (t1, t2))
    pool = await get_pool(DB)
    try:
        kb = KnowledgeBase(pool, HashingEmbedder(1024))
        await kb.ingest(str(t1), str(a1), "faq", "FAQ A", "## Devoluciones\nEn la tienda A tienes 30 días.")
        await kb.ingest(str(t2), str(a2), "faq", "FAQ B", "## Devoluciones\nEn la tienda B tienes 15 días.")
        hits_a = await kb.search(str(t1), str(a1), "plazo de devolución")
        assert hits_a and all("tienda A" in h["content"] for h in hits_a)
        # aunque se pida el agente de B con el tenant A, RLS no devuelve nada
        assert await kb.search(str(t1), str(a2), "plazo de devolución") == []
    finally:
        await close_pool()
