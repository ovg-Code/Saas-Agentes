# ADR 0007 — La autonomía es una política (L1-L5 × tier), no código distinto

- Estado: aceptada (2026-09-24)

## Decisión
Un único runtime. Cada capacidad tiene un tier (`read`, `write`, `irreversible`, `financial`) y un ajuste de
aprobación (`policy`, `always`, `never`). El nivel de autonomía del despliegue (L1-L5, limitado por la plantilla)
determina qué se ejecuta solo y qué espera a un humano. La decisión se congela en el release y el runtime la
re-verifica.

## Consecuencias
Pasar un cliente de "asistente" a "agente autónomo" es cambiar una línea del despliegue (dentro de lo que la
plantilla permita), con la misma auditoría y los mismos tests.
