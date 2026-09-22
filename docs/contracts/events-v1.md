# Eventos y outbox v1

Todo evento tiene envelope validado por `OutboxEventSchema`: `id`, `type` versionado, `occurredAt` RFC3339 con offset, `userId`, agregado, `idempotencyKey` y `payload` específico. Los consumidores validan el schema antes de actuar y no aceptan tipos sin sufijo `.v1`.

| Evento                                        | Agregado      | Payload mínimo                                    | Consumidor inicial     |
| --------------------------------------------- | ------------- | ------------------------------------------------- | ---------------------- |
| `source.item.revision.created.v1`             | `source_item` | `sourceItemId`, `sourceItemRevisionId`            | extracción V05         |
| `obligation.candidate.created.v1`             | `obligation`  | `obligationId`, `sourceItemRevisionId`            | reconciliación V06     |
| `obligation.version.created.v1`               | `obligation`  | `obligationId`, `obligationVersionId`, `revision` | avisos V07             |
| `obligation.reminder.reschedule.requested.v1` | `obligation`  | `obligationId`, causa                             | avisos V07/V09         |
| `reminder.delivery.requested.v1`              | `reminder`    | `reminderId`, `targetVersion`                     | proveedor Telegram V07 |
| `reminder.delivery.resolved.v1`               | `reminder`    | `reminderId`, `attemptId`, resultado              | operación V07          |

V03 persiste `OutboxEvent` en PostgreSQL en la transacción que escribe el cambio de dominio. Redis/BullMQ es transporte recuperable, no autoridad: un relé reclama filas de outbox, publica jobs con la clave de idempotencia, registra el intento y recupera pendientes tras reinicio. Consumidores mantienen un registro durable de procesamiento por `(consumer, event_id)` y deben tolerar replay y reordenamiento. No se promete entrega exactamente una vez a Telegram.

## Límite de efectos externos

Un consumidor que llame a un proveedor externo debe persistir primero un intento identificable en PostgreSQL. Sólo después puede ejecutar HTTP, siempre **fuera de una transacción reversible** que contenga cambios de dominio. Al terminar, persiste `sent`, `failed` o `unknown`; timeout, caída de conexión o respuesta ambigua se registran como `unknown` y no se reintentan a ciegas. El contrato `ExternalEffectContract` de `@crashmemory/runtime` expresa esta secuencia para V07.

El recibo V03 garantiza idempotencia de efectos que comparten su transacción PostgreSQL; no convierte HTTP, Telegram ni otro proveedor en exactly-once. Un tipo de evento sin consumidor registrado falla el job y queda visible para replay: nunca se reconoce mediante un handler vacío.
