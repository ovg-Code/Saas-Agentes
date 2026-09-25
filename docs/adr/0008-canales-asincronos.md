# ADR 0008 — Canales asíncronos: un único camino de salida (puerto ChannelSender)

- Estado: aceptada (2026-09-25)

## Contexto
En widget, API y MCP la respuesta vuelve en la misma petición HTTP. En WhatsApp (y email) no: el mensaje
entra por un webhook y la respuesta hay que **enviarla**. Además hay respuestas que nacen sin que el cliente
escriba: una aprobación que se resuelve horas después, una persona del equipo que responde en un handoff, una
aprobación que expira en Temporal.

## Decisión
- Todo texto para el cliente final sale por `ConversationService.deliver()` → puerto `ChannelSender`
  (definido en `conversations`, implementado por `channels/whatsapp.ts` sin importar `conversations`:
  sin ciclos, verificado por dependency-cruiser).
- La entrada (webhook) usa otro puerto (`InboundChatPort`) y reutiliza `sendMessage`: un mensaje de WhatsApp
  es un turno más, con las mismas políticas, aprobaciones, auditoría y webhooks salientes.
- Reglas de WhatsApp dentro del canal: firma HMAC del cuerpo crudo, 200 inmediato + proceso asíncrono,
  deduplicación por `wamid` (`channel_inbound`), ventana de 24 h (`conversations.last_customer_at`) con plantilla
  de reenganche o `channel.outside_window` auditado, textos partidos a 4096 caracteres.
- Una conversación por número (`external_user = wa_id`) mientras no esté cerrada.

## Consecuencias
- Añadir email u otro canal = implementar `ChannelSender` + su webhook de entrada.
- El proceso asíncrono vive en el proceso de la API (reintento corto). Para entrega at-least-once con reintentos
  de horas se moverá a una actividad de Temporal (igual que los webhooks salientes, ver ADR 0002).
