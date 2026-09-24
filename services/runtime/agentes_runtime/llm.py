"""Clientes LLM.

GatewayLlm: SDK oficial de Anthropic apuntando al gateway (LiteLLM). LiteLLM expone la API
Messages (/v1/messages) para CUALQUIER proveedor, así que el runtime habla un único formato y
cambiar de proveedor/modelo es configuración del gateway (alias), no código.
Cada tenant usa su propia virtual key del gateway -> presupuestos y rate limits por cliente.

FakeLlm: "modelo" determinista basado en reglas para desarrollo sin coste y para las evals de
cableado en CI. No pretende ser inteligente: verifica tools, políticas y estados de la conversación.
"""

from __future__ import annotations

import json
import re
from typing import Any

import anthropic

from .engine import LlmRequest, LlmResponse


class GatewayLlm:
    def __init__(self, base_url: str | None, api_key: str, tenant_keys: dict[str, str] | None = None):
        self._base_url = base_url
        self._default_key = api_key
        self._tenant_keys = tenant_keys or {}
        self._clients: dict[str, anthropic.AsyncAnthropic] = {}

    def _client(self, tenant_id: str) -> anthropic.AsyncAnthropic:
        key = self._tenant_keys.get(tenant_id, self._default_key)
        if key not in self._clients:
            self._clients[key] = anthropic.AsyncAnthropic(base_url=self._base_url, api_key=key, max_retries=2)
        return self._clients[key]

    async def __call__(self, request: LlmRequest) -> LlmResponse:
        # El system prompt es estable por release: se marca para prompt caching.
        system = [{"type": "text", "text": request.system, "cache_control": {"type": "ephemeral"}}]
        response = await self._client(request.tenant_id).messages.create(
            model=request.model,
            max_tokens=request.max_tokens,
            system=system,
            tools=request.tools,
            messages=request.messages,
            metadata={"user_id": request.tenant_id},
        )
        return LlmResponse(
            content=[b.model_dump(exclude_none=True) for b in response.content],
            stop_reason=response.stop_reason,
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
            model=response.model,
        )


# --------------------------------------------------------------------------- fake

_ORDER = re.compile(r"\b(\d{3,})\b")
_APPOINTMENT = re.compile(r"\b(C-\d+)\b", re.I)
_HOUR = re.compile(r"\b(\d{1,2})(?::|h)(\d{2})\b")
_HOUR_LOOSE = re.compile(r"\ba las (\d{1,2})\b")
_DATE = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")
_NOW = re.compile(r"ahora es \w+ (\d{4}-\d{2}-\d{2})")
_NAME = re.compile(r"\b(?:soy|me llamo)\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)?)")


def _target_date(text: str, context: str) -> str:
    """Fecha explícita (YYYY-MM-DD) o, si no, 'mañana' respecto a la hora de plataforma del turno."""
    if m := _DATE.search(text):
        return m.group(1)
    if m := _NOW.search(context):
        from datetime import date, timedelta

        return (date.fromisoformat(m.group(1)) + timedelta(days=1)).isoformat()
    return "2026-01-01"


class FakeLlm:
    """Reglas simples por palabra clave -> tool. Suficiente para probar el cableado de extremo a extremo.

    Es un doble de pruebas: conoce los nombres de tools de las plantillas del repo. No sustituye a las evals
    con el modelo real (`LLM_PROVIDER=gateway` + `agentes eval`)."""

    async def __call__(self, request: LlmRequest) -> LlmResponse:
        tools = {t["name"] for t in request.tools}
        last = request.messages[-1]
        blocks = last["content"]
        results = [b for b in blocks if b.get("type") == "tool_result"]
        texts = [b["text"] for b in blocks if b.get("type") == "text"]

        if results and not texts:
            return self._text(self._summarize(results))

        text = texts[-1] if texts else ""
        context = " ".join(texts[:-1])
        low = text.lower()
        order = _ORDER.search(text)
        n = sum(1 for m in request.messages if m["role"] == "assistant")

        def call(name: str, args: dict[str, Any]) -> LlmResponse:
            return LlmResponse(content=[{"type": "tool_use", "id": f"toolu_fake_{n}_{name}", "name": name, "input": args}],
                               stop_reason="tool_use", input_tokens=10, output_tokens=10, model="fake")

        if re.search(r"persona|humano|agente real|hablar con alguien", low) and "humano__escalar" in tools:
            return call("humano__escalar", {"motivo": "El cliente pide hablar con una persona", "resumen": text[:200]})
        # --- plantilla agendar-citas
        appt = _APPOINTMENT.search(text)
        if "cancel" in low and appt and "calendario__cancelar_cita" in tools:
            return call("calendario__cancelar_cita", {"id_cita": appt.group(1).upper()})
        if re.search(r"señal|senal|pagar", low) and appt and "pagos__cobrar_senal" in tools:
            return call("pagos__cobrar_senal", {"body": {"id_cita": appt.group(1).upper(), "importe": 20}})
        hour = _HOUR.search(text) or _HOUR_LOOSE.search(text)
        if "reserv" in low and hour and "calendario__crear_cita" in tools:
            hh = int(hour.group(1))
            mm = hour.group(2) if hour.re is _HOUR else "00"
            name = _NAME.search(text)
            return call("calendario__crear_cita", {
                "fecha": _target_date(text, context), "hora": f"{hh:02d}:{mm}", "servicio": "revisión",
                "nombre_cliente": name.group(1) if name else "Cliente"})
        if re.search(r"hueco|disponib|cita", low) and "calendario__disponibilidad" in tools:
            return call("calendario__disponibilidad", {"fecha": _target_date(text, context)})
        # --- plantilla atencion-cliente
        if "reembols" in low and order and "pedidos__reembolsar" in tools:
            return call("pedidos__reembolsar", {"numero": order.group(1), "body": {"motivo": text[:200]}})
        if re.search(r"ticket|incidencia|queja", low) and "tickets__crear" in tools:
            body: dict[str, Any] = {"asunto": "Incidencia reportada por el cliente", "descripcion": text[:500]}
            return call("tickets__crear", {"body": body})
        if "pedido" in low and order and "pedidos__consultar" in tools:
            return call("pedidos__consultar", {"numero": order.group(1)})
        if "conocimiento__buscar" in tools and text:
            return call("conocimiento__buscar", {"consulta": text})
        return self._text("¿En qué más puedo ayudarte?")

    @staticmethod
    def _summarize(results: list[dict[str, Any]]) -> str:
        parts = []
        for r in results:
            content = r.get("content")
            content = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
            prefix = "No he podido completarlo: " if r.get("is_error") else ""
            parts.append(prefix + content[:400])
        return "Esto es lo que he encontrado: " + " | ".join(parts)

    @staticmethod
    def _text(text: str) -> LlmResponse:
        return LlmResponse(content=[{"type": "text", "text": text}], stop_reason="end_turn",
                           input_tokens=10, output_tokens=10, model="fake")
