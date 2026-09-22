# CrashMemory

CrashMemory es un MVP local para convertir correos autorizados de Gmail en obligaciones con evidencia y enviar recordatorios por Telegram. Incluye login, conexión y desconexión de Gmail, sincronización recuperable, lectura del cuerpo y de PDF con texto, extracción estructurada, reconciliación de cambios, correcciones protegidas, avisos durables, una web mínima y operaciones de exportación, borrado, backup y restore.

La validación V10 usa datos y proveedores simulados. Gmail, Telegram y el modelo remoto reales requieren configuración externa y siguen pendientes de una prueba autorizada con credenciales reales. Los avisos automáticos están apagados de forma predeterminada.

## Requisitos y preparación

- Node `24.14.1` y pnpm `11.25.0`.
- Docker Compose. Los comandos siguientes usan el contexto Docker activo; en este repositorio también se probó `--context colima-crashmemory`.
- PostgreSQL 17, Redis y MinIO incluidos en [infra/compose/docker-compose.yml](infra/compose/docker-compose.yml).

Active las versiones fijadas (Volta puede leer los pines de `package.json`), compruebe `node --version`/`pnpm --version`, instale exactamente el lockfile y cree un archivo privado de configuración:

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
cp .env.example .env
chmod 600 .env
```

Complete `.env` fuera de Git. El Compose local crea el usuario PostgreSQL `crashmemory`, la base de `POSTGRES_DB` y escucha en `POSTGRES_PORT`; use `DATABASE_URL=postgresql://crashmemory:<POSTGRES_PASSWORD>@127.0.0.1:<POSTGRES_PORT>/<POSTGRES_DB>`. Defina la misma contraseña protegida tanto en Compose como en la URL antes de exponer el servicio fuera de localhost. MinIO usa `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`; `OBJECT_STORAGE_ACCESS_KEY` y `OBJECT_STORAGE_SECRET_KEY` deben coincidir con ellos. La plantilla Compose trae valores locales conocidos y sólo publica en `127.0.0.1`; sustitúyalos en una copia protegida para cualquier uso que no sea desarrollo aislado.

Genere cada clave de 32 bytes localmente, por ejemplo `openssl rand -base64 32`. El keyring tiene forma JSON `{"v1":"<base64-de-32-bytes>"}` y `CREDENTIAL_ACTIVE_KEY_VERSION=v1`; OAuth y journal reciben sendas cadenas base64. No reutilice claves, no registre `.env` y no pegue sus valores en logs o incidencias.

Levante los servicios con los puertos y el namespace elegidos en `.env`:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml up -d --wait
```

Cree en MinIO el bucket indicado por `OBJECT_STORAGE_BUCKET` mediante la consola local configurada en `MINIO_CONSOLE_PORT`. Después aplique migraciones y cree el usuario local:

```bash
node scripts/run-local.mjs db:migrate
node scripts/run-local.mjs db:seed
```

El lanzador carga `.env` con `process.loadEnvFile` y pasa el entorno al proceso pnpm sin shell ni imprimir valores. Es necesario porque en Node 24.14.1 se reprodujo que un script hijo iniciado mediante la combinación `--env-file` y `--run` no recibe la variable cargada.

## Arranque y recorrido local

Arranque API, worker, scheduler y web en una terminal:

```bash
node scripts/run-local.mjs dev
```

Abra `APP_ORIGIN` e inicie sesión con la cuenta creada por el seed. El origen web sirve `/api` mediante rewrite a `API_INTERNAL_URL`; por eso `GMAIL_REDIRECT_URI` debe usar el origen público de la web, por ejemplo `http://127.0.0.1:3000/api/v1/gmail/callback`, y no el puerto interno de la API.

El recorrido disponible es:

1. Conectar Gmail y comprobar el estado de sincronización.
2. Abrir una obligación y revisar título, importe decimal exacto, vencimiento civil o instante con zona, historial y evidencia.
3. Confirmar, corregir o resolver una propuesta; un `409` refresca la versión actual antes de otra escritura.
4. Vincular Telegram y consultar avisos e intentos `sent`, `failed` o `unknown`.
5. Marcar la obligación pagada o descartarla; los avisos futuros se cancelan.
6. Desconectar Gmail o desvincular Telegram desde Conexiones. La web muestra si Google confirmó la revocación remota.

Sin un adaptador local de modelo, `EXTRACTION_DEFAULT_PRIVACY_PROFILE=local-only` deja el correo en revisión manual y realiza cero llamadas remotas. `remote-allowed` requiere simultáneamente `MODEL_REMOTE_ENABLED=true`, `MODEL_PROJECT_DATA_CONTROLS_CONFIRMED=true`, una clave, un modelo y un presupuesto vigente. Esa confirmación sólo registra la decisión operativa de usar un proyecto configurado para no entrenar con sus datos; `store:false` no configura la cuenta, no significa ZDR y no elimina la retención de monitoreo aplicable. La disponibilidad y precisión del modelo configurado no se han probado con datos reales.

## Gmail y Pub/Sub

En Google Cloud configure el scope único `https://www.googleapis.com/auth/gmail.readonly` y registre exactamente `GMAIL_REDIRECT_URI`. Complete `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `OAUTH_STATE_SECRET_BASE64`, el keyring de credenciales y:

```dotenv
GOOGLE_PUBSUB_AUDIENCE=https://app.example.test/webhooks/google/gmail
GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL=pubsub-push@example-project.iam.gserviceaccount.com
GMAIL_PUBSUB_TOPIC=projects/example-project/topics/crashmemory-gmail
GMAIL_SYNC_ENABLED=true
```

Conceda a `gmail-api-push@system.gserviceaccount.com` el rol de publicador sobre el topic. Configure una suscripción push HTTPS a `/webhooks/google/gmail` con autenticación OIDC, la cuenta de servicio indicada y la misma audiencia de `GOOGLE_PUBSUB_AUDIENCE`. `next.config.ts` sólo reescribe `/api`: el proxy o túnel HTTPS debe dirigir `/webhooks/google/gmail` directamente al puerto de la API. El endpoint valida emisor, audiencia y correo verificado de la cuenta; una notificación sólo despierta el catch-up y no adelanta el cursor.

El bootstrap conserva como máximo 200 mensajes. Gmail se materializa en lotes de cuatro mensajes, cada lote se persiste antes de cargar el siguiente y el cursor se confirma únicamente al terminar todas las páginas. Los mensajes borrados durante la lectura se omiten; otros fallos dejan el cursor anterior para replay idempotente. El scheduler hace polling de respaldo, recupera historial vencido con resync acotado y renueva el watch dentro de las 48 horas previas a expirar. Las solicitudes Gmail y el refresh tienen timeout de 30 segundos.

## Modelo, presupuesto y revisión

Una clave de proveedor por sí sola no habilita tráfico remoto. Antes de `remote-allowed`, cree un límite para el UUID del usuario y un período UTC vigente:

```bash
node scripts/run-local.mjs --filter @crashmemory/db budget:set -- \
  --user-id '<uuid-local>' --limit-usd '<decimal>' \
  --period-start '<YYYY-MM-DDTHH:mm:ssZ>' \
  --period-end '<YYYY-MM-DDTHH:mm:ssZ>'

node scripts/run-local.mjs --filter @crashmemory/db budget:ledger -- \
  --user-id '<uuid-local>' --limit 25
```

La reserva usa el máximo de entrada/salida configurado y serializa llamadas concurrentes. Una respuesta con uso se registra como estimada; si falta uso se conserva la estimación conservadora. Un timeout deja costo `unknown` y mantiene la reserva, nunca costo cero. El ledger no guarda correo, PDF, prompt, respuesta ni credencial.

PDF con texto conserva página y fragmento. Un PDF escaneado, protegido, ambiguo o mayor que el límite queda en revisión manual; OCR y carga manual de documentos están fuera del MVP.

## Telegram y avisos

Configure `TELEGRAM_BOT_TOKEN` y el mismo keyring. La web genera `/start <código>` de un solo uso y diez minutos; el chat se cifra y el texto entrante no se conserva.

Mantenga `NOTIFICATIONS_AUTOMATIC_ENABLED=false` hasta medir y aprobar la calidad. Para habilitarla, cambie la variable tanto para worker como scheduler y programe obligaciones confirmadas futuras de forma explícita:

```bash
node scripts/run-local.mjs --filter @crashmemory/notifications reminders:backfill
```

El backfill no programa vencimientos históricos y usa claves de deduplicación. Antes de llamar a Telegram se persiste el intento. Un timeout después de preparar queda `unknown` y nunca se reenvía a ciegas; requiere revisión operativa. Pago, descarte, actualización y borrado cancelan recordatorios obsoletos.

## Exportación, borrado y recuperación

Las rutas de ciclo de vida requieren cookie de sesión, `Origin` confiable, `Content-Type: application/json`, `X-CSRF-Token` y un journal cifrado actual en `LIFECYCLE_JOURNAL_PATH`, fuera del checkout y de los backups. La desconexión Gmail borra la credencial local aun si la revocación remota responde `failed` o `not_configured`. El borrado registra primero la intención; las barreras impiden que un replay o restore anterior resucite lo borrado.

| Operación                        | Ruta                                                                      |
| -------------------------------- | ------------------------------------------------------------------------- |
| Cuenta completa                  | `DELETE /api/v1/lifecycle/account`                                        |
| Fuente Gmail                     | `DELETE /api/v1/lifecycle/sources/:connectionId`                          |
| Mensaje de una fuente            | `DELETE /api/v1/lifecycle/sources/:connectionId/items/:externalMessageId` |
| Obligación conservando el correo | `DELETE /api/v1/lifecycle/obligations/:obligationId`                      |

`GET /api/v1/lifecycle/export?includeOriginals=false` exporta metadatos propios; habilitar originales los incluye en base64 hasta 10 MiB cada uno. Si un crash deja `LIFECYCLE_JOURNAL_PATH.lock`, confirme primero que API, worker, scheduler y cualquier CLI estén detenidos; sólo entonces retire ese directorio y reintente. Nunca elimine el lock mientras exista un escritor.

Para backup, detenga API, worker y scheduler y espere que terminen su drenaje. Conserve fuera de Git el journal actual, sus claves y el archivo cifrado:

```bash
LIFECYCLE_QUIESCED=true LIFECYCLE_BACKUP_OUTPUT=/secure/crashmemory.enc \
  node scripts/run-local.mjs --filter @crashmemory/lifecycle backup
```

Sin binarios nativos, configure `LIFECYCLE_PG_CONTAINER` con el contenedor PostgreSQL que aloja `DATABASE_URL` y `LIFECYCLE_DOCKER_CONTEXT`. El adaptador transmite el dump por entrada/salida estándar.

Restaure antes de arrancar cualquier proceso, sobre una base sin esquema y un bucket existente vacío, con el journal actual que extiende el prefijo autenticado del backup:

```bash
LIFECYCLE_QUIESCED=true LIFECYCLE_BACKUP_INPUT=/secure/crashmemory.enc \
  node scripts/run-local.mjs --filter @crashmemory/lifecycle restore
```

El restore valida archivo y journal completos antes de mutar, usa `pg_restore --single-transaction --exit-on-error`, restaura objetos y reaplica tombstones. No desactiva claves foráneas ni triggers. El archivo cifrado se construye en memoria: reserve RAM y disco acordes al dump y los originales; la validación usó un volumen pequeño. Si falla una etapa, descarte base y bucket de destino y repita sobre destinos vacíos. Para reintentar objetos pendientes tras recuperar MinIO:

```bash
LIFECYCLE_CLEANUP_LIMIT=100 \
  node scripts/run-local.mjs --filter @crashmemory/lifecycle cleanup:retry
```

V09.1 probó PostgreSQL 17.6 y MinIO reales en destinos separados. La suite general omite el restore destructivo cuando faltan `TEST_RESTORE_DATABASE_URL`, `TEST_PG_CONTAINER` y buckets aislados; no debe ejecutarse concurrentemente contra la base normal de pruebas.

## Verificación reproducible

Use un namespace desechable con PostgreSQL, Redis y MinIO, cree su bucket y ejecute:

```bash
TEST_DATABASE_URL='<url-base-desechable>' \
TEST_REDIS_URL='<url-redis-desechable>' \
TEST_OBJECT_STORAGE_ENDPOINT='<url-minio-desechable>' \
TEST_OBJECT_STORAGE_BUCKET='<bucket-desechable>' \
TEST_OBJECT_STORAGE_ACCESS_KEY='<desde-entorno-protegido>' \
TEST_OBJECT_STORAGE_SECRET_KEY='<desde-entorno-protegido>' \
  pnpm check

pnpm build
```

La aceptación sintética cubre originales y cuerpo/PDF, extracción fake validada, presupuesto, reconciliación y cambio de vencimiento, replay/concurrencia, campos protegidos y conflictos, evidencia por propietario, recordatorio y envío fake, resultado `unknown` sin reintento, pago/cancelación, borrado y barreras de restore. También comprueba que `local-only` no llama al adaptador remoto, que el presupuesto concurrente se respeta y que dos usuarios no comparten datos. Ninguna prueba contacta Gmail, Telegram u OpenAI reales.

Para crear un recorrido visible en la web, use una base y bucket desechables ya migrados, con API, worker y scheduler detenidos para que no compitan por outbox o trabajos. Configure allí la cuenta de seed y ejecute una vez:

```bash
node scripts/run-local.mjs acceptance:seed
```

El fixture genera una referencia única por ejecución, usa PostgreSQL y MinIO reales con modelo/Telegram fake, deja la obligación, evidencia, conflicto resuelto e intentos visibles y devuelve sus IDs. No lo ejecute sobre datos reales ni sobre el destino normal de desarrollo.

## Estado de aceptación MVP 1

La implementación V10 quedó integrada en `origin/main` como `18cabbecfaa30e766dc49a9cc89f7a77f89dddcb`; las CI candidata `35764125498` y de integración `35764483752` terminaron correctamente. Esta aceptación cubre el recorrido sintético y no sustituye las validaciones externas pendientes indicadas abajo.

| Criterio              | Evidencia V10                                                                        | Estado             |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------ |
| AC-01 reconstrucción  | lockfile, Compose, migración/seed, arranque conjunto y browser desde worktree limpio | Sintético validado |
| AC-02 persistencia    | runtime durable y restore PostgreSQL/MinIO aislado de V09.1                          | Validado           |
| AC-03 incremental     | cursor sólo tras todas las páginas/lotes; resync acotado                             | Validado           |
| AC-04 idempotencia    | replays y consumidores concurrentes no duplican obligación                           | Validado           |
| AC-05 evidencia       | cuerpo/PDF/página y autorización por propietario                                     | Validado           |
| AC-06 actualización   | nueva fecha crea historial y cancela/reprograma avisos                               | Validado           |
| AC-07 privacidad      | `local-only` registra cero llamadas remotas                                          | Validado           |
| AC-08 portabilidad IA | fake y adaptador remoto intercambiables por perfil                                   | Sintético validado |
| AC-09 secretos        | `.env` ignorado, redacción y scan de repo                                            | Validado           |
| AC-10 avisos          | fake durable; `unknown` sin reenvío ciego                                            | Sintético validado |
| AC-11 corrección      | campos protegidos producen conflicto visible                                         | Validado           |
| AC-12 borrado         | cancelación, journal y replay/restore sin resurrección                               | Validado           |

La validación con una cuenta Gmail real autorizada, un bot/chat Telegram real y el modelo remoto configurado sigue pendiente. No se ha medido precisión sobre correos reales, disponibilidad del modelo, volumen grande de backup ni entrega externa exactamente una vez.

## Alcance

El MVP termina en Gmail → obligación con evidencia → Telegram y web mínima. Chat conversacional, Calendar, WhatsApp, OCR, contratos como entidad, contabilidad, recurrencias, carga manual, embeddings, búsqueda semántica, grafo, MCP y despliegue cloud quedan para versiones posteriores.
