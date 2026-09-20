# Plan de implementación multisesión

Versión 1.0 · 2026-09-20 · Proyecto CrashMemory / Cerebro Personal.

Base: [spec v1.0](../specs/cerebro-personal-v1.0.md) y [revisión técnica](revision-spec.md). Este plan transforma los sprints originales en entregas integrables; los identificadores Sxx no equivalen a días ni a una sola ventana de contexto.

## 1. Reglas de ejecución

1. **Máximo cuatro sesiones activas en todo el árbol**, incluidos coordinador, revisores e hijas. Configuración normal: I00 + tres implementadoras. Una sesión en espera deja de ejecutar y libera el cupo; al reanudarse debe reservarlo de nuevo.
2. **Un worktree y una rama exclusivos por sesión**, incluido I00 y cada hija. No compartir checkout, rama, volúmenes de prueba ni bases de datos mutables entre sesiones.
3. Cada sesión comienza desde un commit de `main` que contenga todas sus dependencias. Los árboles expresan responsabilidad, no obligan a apilar ramas Git. Así cada hija puede integrarse al terminar sin esperar a todo su árbol.
4. Cada sesión entrega su propio commit. **Se valida e integra en `main` al terminar esa sesión**, una a la vez. No se espera a completar una ola, un sprint o un hito.
5. **Cada integración incluye una actualización útil de README**, validada sobre el resultado combinado. La entrega no está completa si solo cambió código.
6. I00 administra cupos, contratos, conflictos y orden de migraciones. Si una dependencia cambia, se actualiza la ficha y se verifica el consumidor antes de integrar.
7. Los contratos, los datos y la seguridad son parte de cada entrega. No se posponen todos los tests o correcciones a la sesión final.
8. El plan no inicia sesiones de implementación. S00 es la entrega documental de esta revisión; S01–S26 e I00 quedan pendientes de ejecución.

## 2. Agentes y costo

Los modelos indicados aparecen como disponibles en este entorno. La elección sigue la guía oficial: Luna para tareas claras y repetibles, Terra para trabajo cotidiano con herramientas y Sol para trabajo complejo. Se usa el esfuerzo mínimo razonable y se aumenta solo con evidencia de dificultad. [OpenAI Docs: elección de modelos y esfuerzo](https://learn.chatgpt.com/docs/models#choosing-sol-terra-and-luna).

| Código | Modelo | Esfuerzo habitual | Encargo apropiado |
| --- | --- | --- | --- |
| L | `gpt-5.6-luna` | `medium` | Interfaces acotadas sobre APIs estables, documentación operativa y transformaciones. |
| T | `gpt-5.6-terra` | `medium`; `high` cuando se indica | Implementación habitual, conectores, pipelines y pruebas con criterios concretos. |
| S | `gpt-5.6-sol` | `high` | Contratos transversales, seguridad, concurrencia/versionado y aceptación de hitos. |

No se asigna Astra por defecto ni se usa `max`/`ultra`. La mención a ASTRA en §104 del spec es una posibilidad de revisión, no un requisito de ejecución. Los modelos de estas sesiones son independientes de los modelos que el producto elegirá mediante ModelGateway.

Si Luna no resuelve un fallo reproducible después de dos intentos enfocados, se escala esa sesión a Terra; de Terra a Sol solo cuando el bloqueo exige mayor análisis. Registrar causa, resultados y consumo disponible. No añadir un revisor caro a todas las tareas ni escalar por longitud del archivo. El catálogo y los precios deben verificarse al ejecutar; no se estima un importe total sin mediciones. El costo de API no equivale automáticamente al consumo del plan de Codex.

## 3. Hitos y árboles

| Hito | Cierre | Resultado que habilita |
| --- | --- | --- |
| S00 | Esta entrega | Spec preservado, revisión, plan y README. |
| M0 | S01–S02 | Contratos acordados y monorepo local arrancable en modo demo. |
| M1 | S03–S15 | Gmail → evidencia → obligación → actualización → Telegram, web, chat estructurado y costos; incluye operación básica y borrado. |
| M2 | S16–S25 | MVP de §85 completo, con fuentes adicionales, contratos, gastos, semántica, grafo y MCP de lectura. |
| M3 | S26, opcional | WhatsApp oficial según canal y permisos verificados. |

Árbol lógico de coordinación; no representa sesiones que deban permanecer todas activas:

```text
I00 · Coordinación e integración (Terra)
├── Base: S01 → S02 → S03
├── Servicios compartidos: S04, S05, S06
├── Memoria M1: S07, S08 → S09
├── Uso M1: S10, S11, S12 → S13
├── Operación y cierre M1: S14 → S15
├── Fuentes M2: S16, S17, S21
│   └── Dominio documental: S19, S20
├── Consulta M2: S18 → S22, S23
└── Entrega M2: S24 → S25 → S26 opcional
```

La tabla de dependencias de la siguiente sección es autoritativa; el árbol solo agrupa responsabilidades. Si una sesión necesita dividirse, I00 crea, por ejemplo, S17a y S17b, cada una con entrega autónoma, agente apropiado y dependencia explícita. Su padre no consume un quinto cupo mientras coordina a cuatro hijos.

## 4. Sesiones y dependencias

Todas están **planificadas**, salvo S00 (documentación elaborada). `Requiere` significa «integrado y verificado en main». Los nombres de ramas se derivan exactamente de la columna `Slug`: `codex/<slug>`. Los worktrees son `<WT_ROOT>/<slug>`; `WT_ROOT` será una carpeta persistente externa al checkout principal, registrada por I00. No se crean carpetas dentro de otros worktrees.

I00 usa `codex/i00-integration` y `<WT_ROOT>/i00-integration`, modelo T / `medium`. Tiene uso exclusivo de las integraciones; emplea S / `high` solo para un conflicto complejo documentado, dentro del mismo cupo. Para una revisión como S00 el perfil recomendado es S / `high`; esta entrega usa `codex/s00-plan` y el worktree temporal `/private/tmp/crashmemory-s00-plan`. Las sesiones futuras utilizarán la ubicación persistente acordada.

| ID / slug | Agente / esfuerzo | Requiere | Entrega y áreas propias | Aceptación principal y README |
| --- | --- | --- | --- | --- |
| S01 · `s01-contracts` | S / high | S00 | Suplemento del spec, ERD, OpenAPI/esquemas de contrato, ADR-001…012 y decisiones R02–R12. `docs/architecture`, `docs/adr`, `docs/threat-model`, contratos iniciales. | Identidad/versiones/evidencia, dinero/fechas, login, colas, privacidad, grafo y estados sin ambigüedades. README explica arquitectura y cómo consumir contratos. |
| S02 · `s02-foundation` | T / medium | S01 | pnpm/Turborepo, Next.js/Fastify, esqueletos worker/scheduler, Compose con PostgreSQL/pgvector/pg_trgm/Redis/MinIO, migración base, CI y healthchecks. Archivos raíz, `apps/*`, `infra/docker`, `.github/workflows`. | Arranque desde clon limpio con fixtures, sin credenciales cloud; volúmenes persisten tras recrear contenedores. README con comandos reales, puertos y modo demo. CI exige README por entrega. |
| S03 · `s03-memory` | S / high | S02 | Memoria canónica M1, revisiones de fuente, evidencia, entidades, obligaciones/citas, correcciones y tablas de soporte acordadas (cursor, outbox, intentos, ledger, sesiones). `packages/db`, `canonical-model`, `schemas`, migraciones. | Restricciones por usuario, integridad de evidencia, unicidad y migración desde DB vacía. Esquemas de módulos futuros solo se materializan al necesitarlos. README con migraciones/seed/consulta de ejemplo. |
| S04 · `s04-security` | S / high | S03 | Login/logout/sesión, autorización, callbacks, cifrado y rotación de tokens, redacción de logs, política HTTP saliente. `packages/security`, rutas auth y pruebas de permisos. | Dos usuarios no leen ni modifican datos, evidencia ni objetos ajenos; datos reales requieren autenticación. README explica alta/login, configuración y recuperación. |
| S05 · `s05-runtime` | T / high | S03 | Outbox, consumidores idempotentes, BullMQ, recuperación desde DB, ObjectStorage y OpenTelemetry. `apps/worker`, `apps/scheduler`, adaptadores de almacenamiento/observabilidad. | Caída entre commit y encolado, reinicio de workers y pérdida de Redis no pierden intención de trabajo. README explica jobs fallidos, replay, métricas y almacenamiento. |
| S06 · `s06-model-gateway` | T / high | S03 | ModelGateway, privacidad para generate/embed/vision, adaptador fake, al menos un remoto configurado y puerto local; ledger, reservas y límites de presupuesto. `packages/model-gateway`. | `local-only` no hace HTTP remoto; salida inválida se rechaza; cambio de proveedor no altera dominio; concurrencia respeta presupuesto. README de perfiles y configuración segura; un puerto local sin backend no se anuncia funcional. |
| S07 · `s07-gmail` | T / high | S04, S05 | OAuth de fuente, histórico acotado, MIME/normalización, incremental, Pub/Sub, renovación watch y recovery. `packages/connectors/gmail`, rutas de fuente/webhook. | Duplicados/reordenamiento no repiten datos, bootstrap no pierde novedades y cursor inválido se recupera dentro del alcance autorizado. README con scopes, consentimiento, Pub/Sub, sync y reconexión. |
| S08 · `s08-extraction` | T / high | S05, S06 | Parsers, detector de candidatos, extracción de obligaciones/citas, evidence linkage y evals. `packages/extraction`, `skills/detect-obligations`, `evals/obligations`. | Fixtures cubren cantidades COP, fechas ambiguas, JSON inválido y prompt injection; se registran precisión y errores por campo. README explica reprocesar, confirmar candidatos y ejecutar evals. |
| S09 · `s09-reconciliation` | S / high | S08 | Dedupe semántico controlado, versiones, conflictos, correcciones protegidas y transacciones. `packages/reconciliation`, servicios de dominio. | Segundo correo cambia fecha con una única versión actual; dos workers y corrección manual no generan pérdida de cambios. README describe historial, conflictos y correcciones. |
| S10 · `s10-obligations-web` | T / medium | S04, S09 | API de obligaciones/evidencias y web: dashboard básico, lista/detalle, confirmar, descartar, marcar pagada, timeline y calendario de citas extraídas. `apps/api` rutas propias; `apps/web` pantallas propias. | Flujo web real a DB con evidencia, fuente y confianza; estados vacíos/error y filtros. README con rutas y pasos de uso. La conexión de Google Calendar llega en S16. |
| S11 · `s11-reminders` | T / high | S04, S05, S09 | Política, scheduler, NotificationGateway y proveedor Telegram; asociación con código de un uso/expiración, privacidad de mensajes y auditoría. `packages/notifications`, handlers de reminders. | Pagar/cambiar fecha cancela avisos obsoletos; retries no duplican intentos confirmados; timeout ambiguo se distingue. README para vincular bot, configurar avisos y resolver `unknown`. |
| S12 · `s12-costs-settings` | L / medium | S04, S06 | APIs/pantallas de costos, presupuestos y ajustes de perfiles/privacidad sobre contratos ya fijados. `apps/api` costos; `apps/web` settings/costs. | Agregados coinciden con ledger; desconocido/estimado visible; no expone secretos ni permite eludir políticas. README con lectura del costo, presupuestos y bloqueo por privacidad. |
| S13 · `s13-chat-m1` | T / medium | S06, S10 | Intent router, consultas estructuradas permitidas, conversación persistida, citas verificadas y UI de chat. `packages/memory` consultas, rutas chat y `apps/web/chat`. | «¿Qué tengo que pagar esta semana?» usa SQL y zona del usuario, cita evidencia accesible y declara límites. No habilita herramientas de contratos/gastos aún inexistentes. README con preguntas disponibles. |
| S14 · `s14-lifecycle` | T / high | S07, S09, S11, S12, S13 | Desconectar/revocar, borrado por fuente/conector/cuenta, exportación M1, backup/restore inicial y UI de privacidad. Servicios de ciclo de vida, `scripts`, settings/privacy. | Borrado impide reaparición por jobs; conserva solo soporte válido; restore de PostgreSQL + objetos probado. README con exportación, borrado, retención y recuperación. |
| S15 · `s15-m1-validation` | S / high | S10, S11, S12, S13, S14 | E2E, pruebas de fallos y acta de M1. `tests/e2e`, evals e informe de aceptación. | Trece pasos de §102, AC-01…12 para el alcance M1 y walkthrough desde README. Separar demo/fakes de prueba real autorizada; M1 real pendiente si faltan credenciales. |
| S16 · `s16-calendar` | T / high | S15 | Conector Google Calendar, permisos independientes, incremental, recurrencias, excepciones y cancelaciones; UI de fuente. `packages/connectors/calendar`. | Actualización/cancelación mueve el estado y sus avisos sin duplicarlo con citas de emails; tests de TZ y all-day. README para conectar, sincronizar y resolver errores. |
| S17 · `s17-documents-imports` | T / high | S15 | Upload S3, PDF/DOCX/TXT/EML, imágenes y adaptador OCR con implementación local básica; interfaz de importación y exports Telegram/WhatsApp de muestra. `packages/connectors/imports`, document-processing, API/UI documents. | Texto y página/offset verificables; tamaños/MIME/límites, documentos malformados y repetidos controlados. Fixtures exportados sintéticos versionados y formatos soportados explícitos. README para subir/importar y estados OCR. |
| S18 · `s18-semantic-memory` | T / high | S15 | Chunking de revisiones, embeddings mediante gateway, pgvector, invalidación y búsqueda híbrida; chat con retrieval y citas. `packages/memory`, jobs embedding. | Nunca recupera texto de otro usuario o evidencia invalidada; cambio de modelo/dimensión no mezcla vectores. Documento→chunks se conecta mediante contrato de SourceItem. README de búsqueda, reindexación y privacidad. |
| S19 · `s19-contracts` | T / high | S17 | Contract/ContractTerm, extractores, revisión humana, páginas de evidencia, timeline y avisos. Esquema/migración propios, `evals/contracts`, API/UI contracts. | PDF y escaneo producen fechas/avisos verificables; ambigüedad queda candidata; borrado/exportación incluyen términos. README con subida, revisión y plazos. |
| S20 · `s20-expenses` | T / high | S17 | Gastos desde correo/documento, merchant/categorías, recurrencia como entidad separada, API/web/charts y PNG local. Esquema/migración propios, `evals/expenses`. | SQL calcula por moneda; evita duplicar factura/recibo; recurrencia separada de cada ocurrencia, fechas límite y fin de mes probados. README con filtros, reglas, recurrencias y reporte PNG. |
| S21 · `s21-telegram-input` | T / medium | S15 | Ingestión de mensajes enviados al bot y conversación con las mismas consultas/políticas del chat. `packages/connectors/telegram`, handlers de entrada. | Replay de update no duplica fuentes/respuestas; asociación de usuario verificada; texto recibido no habilita herramientas. README con comandos y alcance del bot. |
| S22 · `s22-graph` | L / medium | S16, S19, S20 | API de proyección del grafo acordada en S01 y React Flow, navegación a recursos/evidencia; límites de profundidad y paginación. API graph, UI graph. | Relaciones muestran contratos/obligaciones/gastos sin copiar datos canónicos ni cruzar usuarios. README con navegación, filtros y límites. Escalar a Terra si aparecen cambios de modelo. |
| S23 · `s23-mcp` | T / medium | S16, S18, S19, S20 | MCP autenticado de lectura sobre servicios existentes, herramientas tipadas y compatibilidad documentada. `mcp/`, contract tests. | Lectura aislada por usuario, sin herramientas de escritura; protocolo/SDK fijados y cliente real de prueba. README con instalación/configuración del cliente y herramientas. |
| S24 · `s24-operations` | T / medium | S16, S18, S19, S20, S21 | Imágenes OCI, escaneo/SBOM/attestation, automatización de backups/restore ampliada, base Terraform, plantillas OIDC y runbooks. `infra`, `.github/workflows`, `scripts`, docs operativas. | Reconstrucción local y restore M2; validaciones de IaC y CI. Destino cloud no seleccionado queda explícitamente pendiente, sin declarar un despliegue realizado. README con actualizar, restaurar y preparar despliegue. |
| S25 · `s25-mvp-validation` | S / high | S16, S17, S18, S19, S20, S21, S22, S23, S24 | Aceptación M2, regresión M1, evals ampliadas, aislamiento, borrado/exportación total y medición de SLOs. Pruebas e informe de release. | MVP de §85 trazado a pruebas; walkthrough desde clon limpio; restricciones y rendimiento medidos, sin afirmar SLA por una prueba local. README completo de uso y operación. |
| S26 · `s26-whatsapp` | T / high | S25 + canal oficial y permisos definidos | Adaptador oficial de notificación/conversación y entrada posterior a habilitación. | Solo se inicia al conocer permisos/canal/costos aplicables; no presupone acceso a historial. README con habilitación y límites reales. No bloquea M2. |

Cada fila incluye su migración, validación, autorización, evidencia, observabilidad y documentación cuando corresponda. S14 crea el mecanismo de ciclo de vida; S16–S23 deben registrar sus nuevos tipos en borrado/exportación y probarlos, sin dejar ese trabajo íntegro a S25.

## 5. Agenda con límite de concurrencia

Las olas muestran una ejecución válida con máximo I00 + tres sesiones. Son una guía de capacidad, no barreras artificiales: la siguiente sesión puede comenzar tan pronto estén integradas sus dependencias y haya un cupo.

| Ola | Cupo 1 | Cupo 2 | Cupo 3 | Cupo 4 | Condición de avance |
| --- | --- | --- | --- | --- | --- |
| 0 | I00 | S01 | — | — | Contratos integrados. |
| 1 | I00 | S02 | — | — | Entorno local M0. |
| 2 | I00 | S03 | — | — | Memoria/esquemas compartidos. |
| 3 | I00 | S04 | S05 | S06 | Seguridad, runtime y gateway. |
| 4 | I00 | S07 | S08 | S12 | Fuentes, extracción, costos. |
| 5 | I00 | S09 | — | — | Versionado/reconciliación. |
| 6 | I00 | S10 | S11 | — | Web y notificación. |
| 7 | I00 | S13 | — | — | Chat estructurado. |
| 8 | I00 | S14 | — | — | Ciclo de vida M1. |
| 9 | I00 | S15 | — | — | M1 validado. |
| 10 | I00 | S16 | S17 | S18 | Calendar, documentos, semántica. |
| 11 | I00 | S19 | S20 | S21 | Contratos, gastos y bot. |
| 12 | I00 | S22 | S23 | S24 | Grafo, MCP y operación. |
| 13 | I00 | S25 | — | — | M2 validado. |
| 14 opcional | I00 | S26 | — | — | Condiciones de WhatsApp satisfechas. |

Un slot libre no obliga a adelantar integraciones ajenas a M1. Los trabajos opcionales no compiten con su ruta crítica. I00 mantiene un registro de reservas en las fichas de sesión; ninguna hija puede reservar cupos por su cuenta. No se habilita paralelismo automático que ignore este límite.

## 6. Protocolo de worktrees, commits e integración

### Inicio

I00 registra `base_sha`, rama, ruta, modelo, dependencias, archivos propios y cupo en la [plantilla](plantilla-sesion.md). Crea la rama sobre `main` validado. Ejemplo para S07, una vez resueltas sus dependencias:

```bash
# Ejecutar desde el repositorio principal; elegir antes WT_ROOT persistente.
git worktree add -b codex/s07-gmail "$WT_ROOT/s07-gmail" main
```

`WT_ROOT` debe apuntar a una carpeta externa al checkout y tener permisos de escritura. Si se usa la creación de worktrees administrada de Codex, registrar la ruta que devuelve y crear/seleccionar la rama asignada; no trabajar en detached HEAD. Cada sesión tiene configuración local ignorada por Git, `COMPOSE_PROJECT_NAME`, puertos y volúmenes propios, creados por el bootstrap de S02. No copiar credenciales reales como parte del setup de pruebas.

### Entrega de una sesión

1. Actualizar su rama con el `main` vigente mediante merge, resolver conflictos propios y ejecutar checks relevantes. Evitar reescribir historial que otra sesión consuma.
2. Terminar comportamiento, migraciones y manejo de fallos. Correr lint/typecheck/tests aplicables y pruebas de aceptación de su ficha.
3. Actualizar README con pasos que funcionen en esa entrega. Incluir acta en `docs/sessions/Sxx.md`, configuración de ejemplo sin secretos y cambios de compatibilidad.
4. Revisar el diff y crear un commit identificable, por ejemplo `feat(gmail): add incremental sync (S07)`. Entregar a I00 el SHA exacto, validaciones y limitaciones.
5. Marcar `lista_para_integrar`. Una limitación que impide el objetivo no se disfraza como sesión terminada.

### Integración inmediata y serializada

I00 adquiere el único bloqueo de integración. Su worktree exclusivo debe estar limpio y en `codex/i00-integration`, alineado por fast-forward con el `main` vigente. Integra el **SHA de entrega** de una sesión con un merge identificable; ejecuta comprobaciones sobre ese resultado y verifica README antes de avanzar `main`.

```bash
# En el worktree exclusivo de I00, limpio.
git merge --ff-only main
git merge --no-ff --no-commit "$SESSION_SHA"

# Revisar cambios, README y migraciones; ejecutar checks definidos por S02.
# Si pasan, crear el merge commit de la sesión.
git commit -m "merge: integrate S07 gmail with usage docs"

# En el checkout de main, limpio y bajo el mismo bloqueo de integración.
git merge --ff-only codex/i00-integration
```

Antes del fast-forward se comprueba que `main` sigue en el SHA base capturado. Si alguien lo avanzó, no se fuerza: I00 incorpora el nuevo `main`, resuelve y repite las validaciones afectadas. Si fallan checks durante el merge, devuelve la sesión con el fallo reproducible; puede abortar el merge preparado conservando todos los commits de la rama de sesión. Nunca se avanza `main` con pruebas rojas o README inconsistente.

El cierre de S00, que solo contiene documentación y no tiene integraciones concurrentes, puede hacerse por fast-forward desde `codex/s00-plan`; mantiene commit propio, worktree separado y actualización de README. I00 se introduce al ejecutar S01.

El avance de `main` local no implica publicar, desplegar ni notificar externamente. Si la ejecución utiliza PRs y protecciones remotas, aplicar el mismo proceso con checks obligatorios y cola serial; el merge remoto sustituye al fast-forward local y después se sincronizan los checkouts. No esquivar protecciones ni usar force-push. Las sesiones dependientes parten del commit realmente integrado.

Tras integrar, actualizar el estado de la sesión y liberar su cupo. Conservar ramas/actas hasta comprobar recuperación; eliminar solo worktrees limpios y ya integrados. Ante un defecto posterior, revertir el merge o integrar un fix con su README; una migración destructiva no se revierte automáticamente al revertir código.

### Conflictos previsibles

| Recurso compartido | Regla |
| --- | --- |
| `README.md` | Cada sesión añade su delta en su rama. I00 conserva todas las instrucciones vigentes al integrar, comprueba rutas/comandos y actualiza estado del hito. |
| Contratos/API | Cambios aditivos y versionados; el dueño comunica cambio a consumidores. No redefinir esquemas en cada feature. |
| Migraciones | Cada sesión es dueña de sus cambios; I00 reserva orden y valida desde vacío y desde main. No editar migraciones aplicadas. Si el generador mantiene snapshots/journal global, regenerar contra main con exclusión de escritura y volver a probar. |
| `pnpm-lock.yaml` y manifests raíz | S02 fija convenciones; las demás sesiones declaran dependencias y I00 reconcilia/regenera el lockfile con pnpm. No resolverlo pegando fragmentos. |
| Registro de rutas/jobs | Módulos registrables por feature; I00 serializa cambios en el punto central. |
| DB, Redis, MinIO, puertos | Namespace por worktree; pruebas usan datos sintéticos propios. No ejecutar dos migradores sobre la misma DB compartida. |

## 7. Definition of Done por integración

- Objetivo y criterios de la sesión demostrados; permisos, validación, evidencia y fallos cubiertos según el dominio.
- Pruebas relevantes pasan sobre la rama y sobre el resultado combinado; CI de S02 ejecuta lint, formato, typecheck, unit/integration, migraciones y build aplicables.
- Migraciones nuevas ejecutadas desde vacío y desde el estado anterior; datos persistentes sobreviven al reinicio cuando la entrega los afecta.
- README actualizado y probado; `.env.example` refleja nombres nuevos y no contiene credenciales.
- Contratos compartidos compatibles o transición documentada con consumidores actualizados.
- Sin datos personales ni secretos en Git; logs y errores redactados.
- Commit de entrega y acta registrados; integración serial completada. Las validaciones externas pendientes quedan separadas de las comprobaciones locales.

En S02, CI rechazará un diff de entrega respecto de su base que no modifique `README.md`. Esto prueba presencia del cambio; I00 comprueba su contenido y ejecuta el walkthrough afectado. Los comandos de instalación y tests se fijan en S02: este plan no presenta scripts inexistentes como disponibles hoy.

## 8. Aceptación y trazabilidad

| Requisito del spec | Dueño | Prueba de cierre |
| --- | --- | --- |
| AC-01 reconstrucción | S02, S24, S25 | Clon limpio, configuración documentada y arranque; separar modo demo de servicios reales. |
| AC-02 persistencia | S02, S05, S14 | Recrear containers y restaurar DB/objetos manteniendo conocimiento y trabajo pendiente. |
| AC-03 incremental | S07, S16 | Novedad procesada sin relectura innecesaria; recovery explícito de cursor inválido. |
| AC-04 idempotencia | S05, S08, S09 | Repetir evento, payload y job, incluida concurrencia, sin doble entidad actual. |
| AC-05 evidencia | S03, S10, S17, S19 | Navegar al fragmento/revisión/página correctos y respetar permisos. |
| AC-06 actualización | S09, S11 | Fecha cambia con histórico y avisos previos cancelados. |
| AC-07 privacidad | S06, S18 | Espía de transporte demuestra cero llamadas remotas en `local-only`, incluso fallback/embedding/visión. |
| AC-08 portabilidad IA | S06, S08, S18 | Dos adaptadores intercambiables por perfil, uno puede ser fake para contrato; integración real se registra aparte. |
| AC-09 secretos | S02, S04, S24 | Scan de repo/artefactos y prueba de redacción de logs/configuración. |
| AC-10 avisos | S11, S15 | Retries internos deduplicados; simular caída tras envío y verificar `unknown` sin reenvío ciego. |
| AC-11 corrección | S09, S15 | Nueva inferencia no pisa un campo fijado; conflicto visible. |
| AC-12 borrado | S14, S18–S23, S25 | Fuente eliminada invalida soporte, cancela avisos/jobs y no reaparece al reindexar/restaurar. |

S15 recorre los trece pasos de §102: login, OAuth Gmail, histórico, factura, obligación, evidencia, actualización, reconciliación, reminder, entrega Telegram, pregunta en chat, respuesta SQL con cita y costos. Un mock valida el software, pero no demuestra consentimiento real ni entrega externa: sin configuración autorizada se informa «M1 demo validado / M1 real pendiente».

S25 añade Google Calendar, archivos, contratos, gastos, recurrencias, semántica, grafo, Telegram de entrada, MCP, privacidad y operación completa. Evalúa calidad con fixtures y conjunto de validación separado; registra tamaño/muestra y errores. Las notificaciones automáticas requieren política habilitada y calidad medida. Antes de eso se permite confirmación humana y notificaciones de prueba controladas.

## 9. Cobertura de tickets iniciales

| Tickets del spec | Sesión principal |
| --- | --- |
| PB-001…004, PB-006…008, PB-033, base PB-034…035 | S02; S05 completa jobs durables y S24 completa empaquetado. |
| PB-005, PB-031 | S05. |
| PB-009…013, PB-024, esquema PB-032 | S03, con contratos de S01. |
| PB-014…017 | S07. |
| PB-018…019, PB-023 | S06; visualización en S12. |
| PB-020…021 | S08. |
| PB-022 | S09. |
| PB-025…027 | S11. |
| PB-028…030 | S10. |
| PB-032 emisión de auditoría | S04–S14 en sus operaciones sensibles. |
| PB-034…036 cierre | S24; S02/S04 dejan controles básicos desde M0/M1. |

Calendar, chat, documentos, contratos, gastos, grafo, MCP y ciclo de vida reciben sesiones explícitas aunque la lista PB-001…036 no los detalle completamente. WhatsApp queda fuera del cierre M2.

## 10. Primer arranque de la ejecución

Crear I00 y S01 con sus modelos y worktrees, registrar dos cupos ocupados y resolver los contratos de S01. Una vez integrada S01, iniciar S02. S03 fija memoria antes de abrir el primer grupo de tres implementadoras: seguridad, runtime y gateway. Cada entrega actualiza README y llega a `main` por separado.

Antes de pruebas externas serán necesarios configuración de identidad, consentimiento Gmail/Calendar, proyecto Pub/Sub cuando corresponda, bot Telegram y política/proveedor de modelos. La ausencia de estas credenciales no impide desarrollar con fixtures, pero sí impide marcar su validación real como completada. El destino cloud y WhatsApp se concretan en sus sesiones, sin bloquear M0 ni M1.
