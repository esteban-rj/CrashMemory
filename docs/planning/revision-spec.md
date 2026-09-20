# Revisión de Cerebro Personal v1.0

Fecha: 2026-09-20. Base examinada: `main` en `bd5e3f5`, con un README de una línea y sin código de aplicación. Documento revisado: [especificación original](../specs/cerebro-personal-v1.0.md), incluidas sus secciones 87–104 de implementación.

La arquitectura es una base razonable para empezar, pero la etiqueta «Ready for implementation» necesita una sesión previa de cierre de contratos. Mantendría TypeScript, Next.js, Fastify, PostgreSQL, BullMQ, almacenamiento S3 y ModelGateway. Los cambios propuestos se concentran en contratos de datos, fiabilidad y orden de ejecución.

La especificación se conserva como referencia, sin convertir sus instrucciones internas —incluida la mención a ASTRA— en órdenes para lanzar agentes o implementar el producto. El encargo actual consiste en revisar y planificar. Las decisiones de esta revisión son propuestas de ejecución que S01 deberá formalizar.

## Hallazgos que cambian el plan

| ID | Prioridad y referencia | Problema e impacto | Resolución propuesta y responsable |
| --- | --- | --- | --- |
| R01 | Alta · §§85, 87–94, 100, 102 | M1 incluye chat y costos, aunque el primer gran hito por sprints termina en Telegram. Calendar aparece en el MVP sin sprint propio. Importaciones y operación tampoco tienen cierre explícito. | Separar M0, M1 y M2; incluir chat estructurado y costos en M1; asignar Calendar, importadores, ciclo de vida y operación a sesiones concretas. S01 / I00. |
| R02 | Bloqueante para esquema · §§20–33, 51 | Faltan modelos persistentes para usuario, conexión, credenciales cifradas, documento/blob, revisiones de fuente, enlaces de evidencia y conversaciones. `Evidence`, `ContractTerm` y `SourceCursor` no muestran `userId`, aunque §51 lo exige. | Completar ERD, contratos Zod, cardinalidades, pertenencia por usuario y restricciones. Enlazar evidencias a revisiones inmutables y a versiones de entidades. S01 / S03. |
| R03 | Bloqueante para dinero y fechas · §§22–27 | `amount`, `dueAt` y `structuredValue` no fijan tipos ni semántica. Convertir una fecha sin hora a medianoche UTC puede alterar el día; sumar monedas diferentes produce resultados incorrectos. | Decimal exacto en DB y cadena decimal en API, moneda explícita; distinguir fecha civil de instante y zona IANA. No sumar monedas sin política de conversión. Definir estados, transiciones y límites de confianza sin solapamiento en 0,95. S01 / S03. |
| R04 | Bloqueante para concurrencia · §§18–19, 63–65 | Se exige Redis no autoritativo, pero no hay persistencia de intención de trabajo ni transacción entre cambios en DB y encolado. El diagrama usa `source.item.upserted` y el catálogo enumera `created/updated`. | Outbox transaccional en PostgreSQL, registro de procesamiento/deduplicación, recuperación de jobs y catálogo único de eventos versionados. Cursor y cambios persistidos de forma coherente. S01 / S05. |
| R05 | Alta · §§22, 32–33, 65 | Versionar cambiando el ID puede romper correcciones, recordatorios y referencias. No se define identidad estable, control de concurrencia o política para conflictos. | ID lógico estable + ID de versión; una versión actual por entidad; actualización optimista; correcciones por campo ligadas al ID lógico. Casos dudosos quedan en conflicto. S01 / S09. |
| R06 | Alta · §§30, 54, AC-10 | `dedupeKey` evita programar repetidos, pero no resuelve un timeout después de una entrega externa. Tampoco incorpora claramente versión de objetivo, política y reprogramación. | Registro durable de intentos, exclusión de workers y estados `sent`, `failed`, `unknown`. Ante resultado ambiguo, no reintentar ciegamente; mostrar resolución operativa. Cancelar recordatorios obsoletos al cambiar/pagar/borrar. S01 / S11. |
| R07 | Alta · §§42–43, AC-03 | Faltan recuperación de cursor vencido, renovación del watch, avisos perdidos, revocación OAuth y carrera entre bootstrap e incremental. | Sincronización recuperable, catch-up tras bootstrap, cursor confirmado tras persistir páginas, renovación y sondeo de respaldo; resync controlado dentro del alcance autorizado. S07. |
| R08 | Bloqueante antes de datos reales · §§48–53, 56 | La API de autenticación solo define sesión/logout. Faltan login, callback, sesiones, recuperación, asociación segura del bot y control de acceso a blobs, colas y evidencia. | S01 elige mecanismo de autenticación independiente del OAuth de fuentes; S04 implementa sesiones, CSRF, validación de callbacks, cifrado con rotación y pruebas de aislamiento de dos usuarios. El modo demo queda claramente separado. |
| R09 | Alta · §§35–40, 77–78 | Los umbrales no tienen dataset ni presupuesto de error acordado. `embed(input)` y `vision(...)` no expresan contexto de privacidad, aunque también pueden exportar datos. | Política uniforme para texto, visión y embeddings; bloqueo por defecto sin ruta válida; secretos nunca entran en prompts. Evals por campo, calibración y recordatorios automáticos solo tras habilitar política con evidencia de calidad. S06 / S08 / S15. |
| R10 | Alta · §§40–41 | `costUsd` no distingue estimación de cobro confirmado ni precio aplicado. Los presupuestos pueden superarse con llamadas concurrentes o retries. | Ledger por intento y reserva atómica de presupuesto; precios versionados, estimado/real/desconocido, conciliación de consumo. No presentar costo desconocido como cero. S06 / S12. |
| R11 | Alta · §§81–83, AC-12 | El borrado no define qué pasa si una entidad tiene varias evidencias, si un job antiguo vuelve a crearla o si se restaura un backup anterior al borrado. | Linaje y reevaluación: retirar soporte borrado, conservar solo conocimiento aún sustentado o confirmado manualmente; cancelar trabajos/avisos; barrera contra resurrección. Retención explícita de backups y reaplicación de borrados al restaurar. S14 y extensiones posteriores. |
| R12 | Media · §§28–29, 61 | `Relationship` solo une `Entity`, pero los ejemplos del grafo incluyen obligaciones y contratos. | Definir enlaces tipados entre recursos canónicos y entidades con integridad y aislamiento; proyectarlos a nodos de grafo sin duplicar fuentes de verdad. S01 / S03 / S22. |
| R13 | Media · §§6, 47, 69, 78–84 | OCR, importadores, evals, backups y métricas se describen, pero quedan sin entregas delimitadas. Los offsets de evidencia carecen de convención. | Sesiones específicas; offsets sobre texto normalizado versionado, páginas y trazabilidad OCR. Límites de archivos y procesamiento. Definir carga, ventana y denominador de cada SLO antes de declarar que se cumple. S01 / S17 / S24 / S25. |

## Precisiones comprobadas con documentación externa

Gmail exige renovar `watch` al menos cada siete días y recomienda hacerlo diariamente. Google también describe avisos demorados o perdidos y el uso de sincronización periódica de respaldo. Esto justifica incluir mantenimiento y recuperación dentro de S07. [Guía oficial de push de Gmail](https://developers.google.com/workspace/gmail/api/guides/push).

Un `startHistoryId` fuera del historial disponible produce HTTP 404 y requiere volver a sincronizar. Por eso AC-03 debe medir incrementalidad en condiciones normales y permitir recuperación explícita ante un cursor inválido, sin ampliar silenciosamente la ventana autorizada. [Guía oficial de sincronización](https://developers.google.com/workspace/gmail/api/guides/sync).

`sendMessage` devuelve el mensaje enviado cuando tiene éxito y no documenta un parámetro de idempotencia del cliente. La imposibilidad de asegurar entrega exactamente una vez con un timeout ambiguo es una **inferencia de diseño** a partir de ese contrato. La propuesta conserva AC-10 para retries internos y documenta el caso `unknown`, con su posible necesidad de intervención. [Telegram Bot API: sendMessage](https://core.telegram.org/bots/api#sendmessage).

La revisión MCP `2026-07-28` sí tiene una guía de soporte en el SDK TypeScript; esta indica que su uso se habilita explícitamente. S23 deberá fijar versión de SDK, transporte y compatibilidad con clientes, en vez de asumir que instalar el SDK más reciente activa automáticamente ese protocolo. [Guía oficial del SDK MCP](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28).

## Qué debe cerrar S01

S01 entregará un suplemento versionado a la especificación, ERD, contratos y ADRs. Debe resolver R02–R06, R08, R09 y R12 antes de que otras sesiones diseñen esquemas incompatibles. Se proponen versiones relacionales más auditoría y outbox; no hace falta introducir event sourcing completo para comenzar.

La sesión también fijará: mecanismo de login portable con desarrollo local, estados de obligaciones y gastos, distinción manual/inferido, política de fecha sin hora, evidencia y retención, catálogos de eventos y comandos, nombres de paquetes, contratos HTTP y fixtures sintéticos de referencia. Las elecciones quedan registradas con razones y criterios de prueba.

Se conservará la separación entre autenticarse en Cerebro y autorizar Gmail. Credenciales de proveedores pertenecen al operador y se provisionan por configuración segura. La interfaz permite consentimientos y selección de perfiles, sin solicitar claves de infraestructura al usuario final.

## Alcance resultante

- **M0:** entorno local reproducible y contratos estables.
- **M1:** todos los trece pasos de §102, más pruebas de aislamiento, privacidad, recuperación y borrado para los datos soportados. La demo sintética y la validación real se reportan por separado.
- **M2:** cierre del MVP amplio de §85, incluyendo Calendar, documentos, contratos, gastos, semántica, grafo, Telegram conversacional y MCP de lectura; exportación, restauración y operación verificadas.
- **Posterior:** WhatsApp oficial condicionado a permisos. Se mantienen fuera pagos autónomos, agregación bancaria, Kafka, Neo4j e historial arbitrario de mensajería.

Los cambios propuestos a criterios ambiguos —especialmente AC-03 y AC-10— deben quedar visibles en el suplemento de S01 y sus pruebas. No se marcarán como satisfechas garantías que el sistema no pueda demostrar.
