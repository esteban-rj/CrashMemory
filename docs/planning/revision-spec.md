# Revisión de Cerebro Personal v1.0

Fecha: 2026-09-20. Base examinada: `main` en `bd5e3f5`, con un README de una línea y sin código de aplicación. Documento revisado: [especificación original](../specs/cerebro-personal-v1.0.md), incluidas sus secciones 87–104 de implementación.

**Alcance actualizado por el usuario:** el primer MVP se limita a Gmail, obligaciones con evidencia y notificaciones Telegram. La agenda vigente es V01–V10 más I00 (once sesiones pendientes), según el [plan v1.1](plan-multisesion.md). Los hallazgos sobre funciones ampliadas se conservan como revisión del spec, pero no obligan a implementarlas en MVP 1. Cada commit debe pushearse inmediatamente y cada integración termina con push de main.

La arquitectura es una base razonable para empezar, pero la etiqueta «Ready for implementation» necesita una sesión previa de cierre de contratos. Mantendría TypeScript, Next.js, Fastify, PostgreSQL, BullMQ, almacenamiento S3 y ModelGateway. Los cambios propuestos se concentran en contratos de datos, fiabilidad y orden de ejecución.

La especificación se conserva como referencia, sin convertir sus instrucciones internas —incluida la mención a ASTRA— en órdenes para lanzar agentes o implementar el producto. El encargo actual consiste en revisar y planificar. Las decisiones de esta revisión son propuestas de ejecución que V01 deberá formalizar.

## Hallazgos que cambian el plan

| ID | Prioridad y referencia | Problema e impacto | Resolución propuesta y responsable |
| --- | --- | --- | --- |
| R01 | Alta · §§85, 87–94, 100, 102 | El plan original exige chat/costos para M1 y deja Calendar sin sprint propio. El usuario redujo ahora la primera entrega a Gmail y notificaciones Telegram. | MVP 1 con web mínima y costos internos; chat, panel de costos, Calendar y otras fuentes quedan diferidos. V01 / I00. |
| R02 | Bloqueante para esquema · §§20–33, 51 | Faltan modelos persistentes de usuario, conexión, credenciales, blobs/revisiones de fuente y enlaces de evidencia; algunos tipos omiten userId pese a §51. | Completar modelos y pertenencia por usuario solo para Gmail/obligaciones/avisos; diferir términos contractuales y conversaciones. V01 / V02. |
| R03 | Bloqueante para dinero y fechas · §§22–27 | `amount`, `dueAt` y `structuredValue` no fijan tipos ni semántica. Convertir una fecha sin hora a medianoche UTC puede alterar el día; sumar monedas diferentes produce resultados incorrectos. | Decimal exacto en DB y cadena decimal en API, moneda explícita; distinguir fecha civil de instante y zona IANA. No sumar monedas sin política de conversión. Definir estados, transiciones y límites de confianza sin solapamiento en 0,95. V01 / V02. |
| R04 | Bloqueante para concurrencia · §§18–19, 63–65 | Se exige Redis no autoritativo, pero no hay persistencia de intención de trabajo ni transacción entre cambios en DB y encolado. El diagrama usa `source.item.upserted` y el catálogo enumera `created/updated`. | Outbox transaccional en PostgreSQL, registro de procesamiento/deduplicación, recuperación de jobs y catálogo único de eventos versionados. Cursor y cambios persistidos de forma coherente. V01 / V03. |
| R05 | Alta · §§22, 32–33, 65 | Versionar cambiando el ID puede romper correcciones, recordatorios y referencias. No se define identidad estable, control de concurrencia o política para conflictos. | ID lógico estable + ID de versión; una versión actual por entidad; actualización optimista; correcciones por campo ligadas al ID lógico. Casos dudosos quedan en conflicto. V01 / V06. |
| R06 | Alta · §§30, 54, AC-10 | `dedupeKey` evita programar repetidos, pero no resuelve un timeout después de una entrega externa. Tampoco incorpora claramente versión de objetivo, política y reprogramación. | Registro durable de intentos, exclusión de workers y estados `sent`, `failed`, `unknown`. Ante resultado ambiguo, no reintentar ciegamente; mostrar resolución operativa. Cancelar recordatorios obsoletos al cambiar/pagar/borrar. V01 / V07. |
| R07 | Alta · §§42–43, AC-03 | Faltan recuperación de cursor vencido, renovación del watch, avisos perdidos, revocación OAuth y carrera entre bootstrap e incremental. | Sincronización recuperable, catch-up tras bootstrap, cursor confirmado tras persistir páginas, renovación y sondeo de respaldo; resync controlado dentro del alcance autorizado. V04. |
| R08 | Bloqueante antes de datos reales · §§48–53, 56 | La API de autenticación solo define sesión/logout. Faltan login, callback, sesiones, recuperación, asociación segura del bot y control de acceso a blobs, colas y evidencia. | V01 elige mecanismo de autenticación independiente del OAuth de fuentes; V02 implementa sesiones, CSRF, validación de callbacks, cifrado con rotación y pruebas de aislamiento de dos usuarios. El modo demo queda claramente separado. |
| R09 | Alta · §§35–40, 77–78 | Los umbrales carecen de dataset y presupuesto de error. La política debe cubrir cualquier llamada que exporte datos. | En MVP 1: política de texto estructurado, bloqueo sin ruta válida, secretos fuera del modelo, evals/calibración y habilitación explícita de avisos automáticos. Embeddings/visión se difieren y heredarán la política. V05 / V10. |
| R10 | Alta · §§40–41 | `costUsd` no distingue estimación de cobro confirmado ni precio aplicado. Los presupuestos pueden superarse con llamadas concurrentes o retries. | Ledger por intento y reserva atómica de presupuesto; precios versionados, estimado/real/desconocido, conciliación de consumo. No presentar costo desconocido como cero. V05. |
| R11 | Alta · §§81–83, AC-12 | El borrado no define qué pasa si una entidad tiene varias evidencias, si un job antiguo vuelve a crearla o si se restaura un backup anterior al borrado. | Linaje y reevaluación: retirar soporte borrado, conservar solo conocimiento aún sustentado o confirmado manualmente; cancelar trabajos/avisos; barrera contra resurrección. Retención explícita de backups y reaplicación de borrados al restaurar. V09 y extensiones posteriores. |
| R12 | Diferida · §§28–29, 61 | Relationship solo une Entity, aunque el grafo propuesto incluye obligaciones y contratos. | Resolver enlaces tipados y proyección al abordar el grafo en una versión posterior; no bloquea MVP 1 ni justifica crear tablas futuras ahora. |
| R13 | Media · §§6, 47, 69, 78–84 | Procesamiento documental, evals, backups y métricas no tienen entregas delimitadas; los offsets carecen de convención. | MVP 1 limita documentos al cuerpo del email y PDF adjuntos con texto/página verificable; archivos escaneados requieren revisión manual. Límites de archivos, evals, backup/restore y medición en V05/V09/V10. OCR e importadores generales diferidos. |

## Precisiones comprobadas con documentación externa

Gmail exige renovar `watch` al menos cada siete días y recomienda hacerlo diariamente. Google también describe avisos demorados o perdidos y el uso de sincronización periódica de respaldo. Esto justifica incluir mantenimiento y recuperación dentro de V04. [Guía oficial de push de Gmail](https://developers.google.com/workspace/gmail/api/guides/push).

Un `startHistoryId` fuera del historial disponible produce HTTP 404 y requiere volver a sincronizar. Por eso AC-03 debe medir incrementalidad en condiciones normales y permitir recuperación explícita ante un cursor inválido, sin ampliar silenciosamente la ventana autorizada. [Guía oficial de sincronización](https://developers.google.com/workspace/gmail/api/guides/sync).

`sendMessage` devuelve el mensaje enviado cuando tiene éxito y no documenta un parámetro de idempotencia del cliente. La imposibilidad de asegurar entrega exactamente una vez con un timeout ambiguo es una **inferencia de diseño** a partir de ese contrato. La propuesta conserva AC-10 para retries internos y documenta el caso `unknown`, con su posible necesidad de intervención. [Telegram Bot API: sendMessage](https://core.telegram.org/bots/api#sendmessage).

La revisión MCP `2026-07-28` sí tiene una guía de soporte en el SDK TypeScript; esta indica que su uso se habilita explícitamente. La futura sesión de MCP deberá fijar versión de SDK, transporte y compatibilidad con clientes, en vez de asumir que instalar el SDK más reciente activa automáticamente ese protocolo. [Guía oficial del SDK MCP](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28).

## Qué debe cerrar V01

V01 entregará un suplemento versionado a la especificación, ERD, contratos y ADRs. Debe cerrar los contratos de R02–R06, R08 y R09 aplicables al MVP 1 antes de que otras sesiones diseñen esquemas incompatibles. R12 se difiere con el grafo. Se proponen versiones relacionales más auditoría y outbox; no hace falta introducir event sourcing completo para comenzar.

La sesión también fijará: mecanismo de login portable con desarrollo local, estados de obligaciones y recordatorios, distinción manual/inferido, política de fecha sin hora, evidencia y retención, catálogos de eventos y comandos, nombres de paquetes, contratos HTTP y fixtures sintéticos de referencia. Las elecciones quedan registradas con razones y criterios de prueba.

Se conservará la separación entre autenticarse en Cerebro y autorizar Gmail. Credenciales de proveedores pertenecen al operador y se provisionan por configuración segura. La interfaz permite consentimientos y selección de perfiles, sin solicitar claves de infraestructura al usuario final.

## Alcance resultante vigente

- **Base V01–V03:** contratos del flujo reducido, entorno local, memoria segura y jobs durables.
- **MVP 1 V04–V10:** Gmail → obligación con evidencia → reconciliación → Telegram; web mínima, costos internos, borrado/exportación básica y restauración. Diez sesiones de entrega más I00; la planificación previa no se cuenta como trabajo pendiente.
- **Versiones posteriores:** chat, Calendar, contratos, gastos, recurrencias, importaciones generales, semántica, grafo, MCP, OCR y WhatsApp. Su descripción en el spec original no obliga a ejecutarlas ahora.

El cierre del MVP 1 sustituye la exigencia de completar los trece pasos de §102: chat y dashboard de costos se difieren. Las garantías de privacidad, evidencia y fiabilidad permanecen. La demo sintética y la validación real se reportan por separado.

Los cambios propuestos a criterios ambiguos —especialmente AC-03 y AC-10— deben quedar visibles en los contratos de V01 y sus pruebas. No se marcarán como satisfechas garantías que el sistema no pueda demostrar.
