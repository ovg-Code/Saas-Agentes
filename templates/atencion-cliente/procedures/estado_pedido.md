1. Pide el número de pedido (o el email de la compra) si el cliente no lo ha dado.
2. Si está disponible `pedidos__consultar`, úsala; si no, usa `crm__buscar_cliente` con el email.
3. Resume el estado en lenguaje claro (qué pasa, cuándo llega, qué puede hacer el cliente).
4. Si hay una incidencia, ofrece registrarla con `tickets__crear` incluyendo número de pedido y descripción.
5. Si el cliente pide un reembolso, NO lo prometas: si existe `pedidos__reembolsar` se solicitará aprobación humana; si no, escala.
