1. Averigua el servicio y el día que prefiere el cliente (si dice "mañana" o "el viernes", conviértelo a fecha con el contexto de plataforma).
2. Llama a `calendario__disponibilidad` para ese día. Propón 2-3 huecos concretos; si no hay, ofrece el día siguiente.
3. Cuando el cliente elija, confirma en una frase: servicio, día de la semana, fecha, hora y nombre.
4. Llama a `calendario__crear_cita`. Si la agenda responde que el hueco está ocupado, discúlpate y vuelve al paso 2.
5. Comunica el identificador de la cita y la política de cancelación.
6. Si la señal es obligatoria u opcional y el cliente la acepta, llama a `pagos__cobrar_senal` con el identificador de la cita; explica que una persona del equipo lo confirmará.
