/**
 * Fronteras del monolito modular (ver docs/adr/0001). Se comprueban en CI:
 *  - un módulo solo usa la API pública (index.ts) de otro módulo, nunca sus ficheros internos;
 *  - shared/ no depende de ningún módulo;
 *  - sin ciclos entre módulos.
 * Así cualquier módulo se puede extraer a un servicio sin reescribir a sus consumidores.
 */
module.exports = {
  forbidden: [
    {
      name: "solo-api-publica-entre-modulos",
      severity: "error",
      from: { path: "^apps/api/src/modules/([^/]+)/" },
      to: {
        path: "^apps/api/src/modules/[^/]+/",
        pathNot: ["^apps/api/src/modules/$1/", "^apps/api/src/modules/[^/]+/index\\.ts$"],
      },
    },
    {
      name: "shared-no-depende-de-modulos",
      severity: "error",
      from: { path: "^apps/api/src/shared/" },
      to: { path: "^apps/api/src/modules/" },
    },
    { name: "sin-ciclos", severity: "error", from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.depcruise.json" },
    tsPreCompilationDeps: true,
  },
};
