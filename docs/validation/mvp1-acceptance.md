# Informe de aceptación MVP 1 — V10

Fecha: 2026-09-22. Base inicial verificada: `origin/main` `7bac256a77f9ebce86da350145f0c9e8c8649ab7`; antes de entregar se incorporó por fast-forward el cierre V09.1 `5c68407d952e734e307b54bc254d0eb08b359640`, cuyo CI `35759280009` estaba en `SUCCESS`.

## Entorno sintético

- Namespace Compose: `crashmemory-v10`.
- PostgreSQL 17.6: puerto `54341`, base `crashmemory_v10`.
- Redis: `6401`.
- MinIO: `9031/9032`, bucket aislado.
- API/web: `4320/3010`.
- Node `24.14.1`, pnpm `11.25.0`.
- Gmail, extracción y Telegram: proveedores simulados; cero llamadas a servicios reales.

La migración limpia aplicó `0001`–`0009`. `acceptance:seed` creó un mensaje Gmail sintético con cuerpo y PDF de texto en MinIO, ejecutó extracción fake bajo `local-only`, reconciliación, confirmación, cambio de vencimiento, conflicto protegido y resolución, vínculo Telegram sintético, un envío `sent`, un intento interrumpido `unknown`, replay sin segundo envío, pago y cancelación. Terminó con `remoteCalls=0` y dejó datos visibles en la web. La suite de worker cubrió además PDF escaneado a revisión manual, evidencia y aislamiento de otro usuario.

## Resultado por criterio

| Criterio              | Evidencia                                                                                                     | Resultado y límite                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| AC-01 reconstrucción  | instalación lockfile, Compose aislado, migración, seed, `run-local.mjs dev`, login real en navegador          | Validado desde worktree; no es despliegue cloud.                                                           |
| AC-02 persistencia    | suite runtime con PostgreSQL/Redis/MinIO; restore real de V09.1                                               | Validado. El restore real es evidencia heredada de V09.1 y se ejecutó aislado, no en la suite general V10. |
| AC-03 incremental     | Gmail procesa lotes máximos de cuatro; fallo en lote final no adelanta cursor; replay termina y confirma      | Validado sintéticamente. Gmail real pendiente.                                                             |
| AC-04 idempotencia    | mismo evento consumido concurrentemente; una versión actual; envío fake no se duplica                         | Validado.                                                                                                  |
| AC-05 evidencia       | cuerpo, dos páginas PDF, hash/offset y acceso denegado al segundo usuario                                     | Validado.                                                                                                  |
| AC-06 actualización   | fecha `2027-10-15` → `2027-10-22`, histórico, conflicto, cancelación/reprogramación                           | Validado.                                                                                                  |
| AC-07 privacidad      | tests ModelGateway y fixture informan cero llamadas remotas bajo `local-only`                                 | Validado.                                                                                                  |
| AC-08 portabilidad IA | fake local y contrato remoto intercambiables; remoto bloqueado sin tres controles                             | Validado sintéticamente. Modelo real/disponibilidad pendiente.                                             |
| AC-09 secretos        | `.env` ignorado y 0600; `check:secrets` sin firmas configuradas                                               | Validado para candidato Git.                                                                               |
| AC-10 avisos          | `sent` durable, replay sin segundo envío, preparado interrumpido → `unknown` sin HTTP                         | Validado con proveedor fake. Telegram real pendiente.                                                      |
| AC-11 corrección      | confirmación protege título/importe/vencimiento; propuesta posterior aparece y se resuelve                    | Validado en servicio y UI legible.                                                                         |
| AC-12 borrado         | journal/tombstones y no resurrección en V09.1; V10 hizo clicks reales de desconexión/desvínculo contra API/DB | Validado. Restore/no resurrección procede de V09.1.                                                        |

## Regresiones específicas V10

- `GET /api/v1/reminders/not-a-uuid/attempts` devuelve `400` antes de PostgreSQL.
- Cursores de recordatorio/intento rechazan ID no UUID y fechas civiles imposibles como `2026-02-31`, conservando timestamps PostgreSQL válidos con espacio, zona y microsegundos.
- Un attachment Gmail se descarga una sola vez.
- Una página de 100 IDs mantiene concurrencia y lote persistido máximos de cuatro. Un fallo del último lote conserva el cursor anterior; el replay repite lotes de forma idempotente y después confirma.
- La UI traduce campos protegidos, motivos/propuestas/estados de conflicto, conexiones y avisos. `sessionStorage` bloqueado no impide el login por cookie. La desconexión muestra `remoteRevocation=failed/not_configured`.
- El entorno raíz se propaga por Turbo. Se reprodujo que Node 24.14.1 no propagó al hijo una variable cargada con la combinación `--env-file`/`--run`; el lanzador usa `process.loadEnvFile`, `spawn` sin shell y entorno explícito. Con las versiones Volta fijadas y `node scripts/run-local.mjs dev` directo, API, worker y scheduler emitieron `stopped` y terminaron con código 0 bajo un solo Ctrl+C después de cambiar los comandos a `node --import tsx` y tolerar señales repetidas.

## Comandos y resultados

- `pnpm --filter @crashmemory/gmail test`: 8 pasan, 1 integración omitida sin DB en la ejecución unitaria; cubierta en check completo.
- `TEST_DATABASE_URL=… pnpm --filter @crashmemory/api test`: 6/6.
- `TEST_DATABASE_URL=… pnpm --filter @crashmemory/worker test`: 4/4.
- `TEST_DATABASE_URL=… pnpm --filter @crashmemory/notifications test`: 4/4.
- `TEST_DATABASE_URL=… pnpm --filter @crashmemory/db test`: 5/5.
- `pnpm --filter @crashmemory/model-gateway test`: 6/6.
- `pnpm check` final sobre DB/bucket vacíos V10: 24/24 tareas; único skip, restore aislado sin variables destructivas; secret scan limpio. Log local `/private/tmp/crashmemory-v10-check-final-clean.log`.
- `pnpm build` final: 15/15 tareas. Log local `/private/tmp/crashmemory-v10-build-final.log`.
- Navegador real `agent-browser`: login contra API/DB, sin overlay, pantalla vacía, Conexiones, desconexión Gmail `not_configured` visible y desvínculo Telegram. Evidencia/409 ya tenían QA funcional V08; V10 los cubre mediante API y fixture persistido sin repetir toda la navegación.
- QA independiente de I00: PASS en cuenta/IDs del fixture; obligación pagada revisión 5, historial, Ver texto, propuesta aceptada y campos en español; intentos `Enviado`/`Resultado incierto`; desconexión Gmail, desvínculo Telegram, logout y viewport móvil 390×844 sin errores de página. Captura local `/private/tmp/crashmemory-v10-root-mobile.png`.

## Limitaciones honestas

No se contactó Gmail, Telegram ni OpenAI. Quedan pendientes credenciales y autorización fuera de Git, medición de precisión con correos reales, comprobación del modelo configurado y entrega Telegram real. `store:false` no significa ZDR ni configura por sí mismo controles de cuenta. El backup cifrado se construye en memoria y sólo se probó con volumen pequeño. Los avisos automáticos continúan apagados hasta aprobar calidad y política.

Un check previo sobre la DB que contenía el fixture visible falló porque la prueba de backfill comparaba el total global de obligaciones futuras. El mismo supuesto falló en una DB vacía cuando otras suites paralelas añadieron dos obligaciones. La regresión se corrigió sin omitir casos: exige al menos sus tres obligaciones futuras, seis recordatorios del propietario y seis tras replay. El check final en un segundo destino vacío pasó completo. Un deadlock transitorio previo de outbox pasó 9/9 al aislar el paquete runtime y no reapareció en el check final.
