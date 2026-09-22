# CrashMemory — Gmail recuperable V04

CrashMemory implementa el flujo Gmail → obligaciones con evidencia → avisos por Telegram. V04 conecta la autorización de Gmail, la normalización MIME y la persistencia atómica de revisiones para que V05 pueda extraer desde cuerpo y adjuntos PDF tipados. La extracción, reconciliación y Telegram continúan pendientes.

## Requisitos

- Node `24.14.1` y pnpm `11.25.0`.
- Docker Compose para migraciones y pruebas de integración. En este host se comprobó con el contexto `colima-crashmemory`.

Instale exactamente el lockfile antes del primer arranque:

```bash
pnpm install --frozen-lockfile
```

## Entorno local V04

V04 usa un namespace propio para PostgreSQL, Redis y MinIO. Arranque PostgreSQL y aplique las migraciones, incluida `0004_v04_gmail_sync.sql`:

```bash
COMPOSE_PROJECT_NAME=crashmemory-v04 POSTGRES_PORT=54332 POSTGRES_DB=crashmemory_v04 \
REDIS_PORT=6392 MINIO_PORT=9015 MINIO_CONSOLE_PORT=9016 \
  docker compose -f infra/compose/docker-compose.yml up -d postgres --wait

DATABASE_URL=postgresql://crashmemory:crashmemory@127.0.0.1:54332/crashmemory_v04 \
  pnpm db:migrate
```

Para ejecutar API y scheduler en esta base use `API_PORT=4314`, `APP_ORIGIN=http://127.0.0.1:3004`, `APP_SESSION_COOKIE_NAME=crashmemory_v04_session`, el mismo `DATABASE_URL`, y `REDIS_URL=redis://127.0.0.1:6392`. Antes de habilitar Gmail real, cree un usuario sintético con el comando de la sección siguiente y configure las variables OAuth descritas en [Gmail V04](#gmail-v04).

## Entorno histórico V03

La configuración de ejemplo reserva el proyecto Compose `crashmemory-v03`, PostgreSQL `54331`, Redis `6391`, MinIO `9013/9014`, API `4312` y web `3002`. Los servicios sólo publican en loopback. Para levantar PostgreSQL y aplicar las migraciones ejecutadas en esta entrega:

```bash
POSTGRES_PORT=54331 POSTGRES_DB=crashmemory_v03 \
  docker compose -p crashmemory-v03 \
  -f infra/compose/docker-compose.yml up -d postgres

DATABASE_URL=postgresql://crashmemory:crashmemory@127.0.0.1:54331/crashmemory_v03 \
  pnpm db:migrate
```

El comando es portable y usa el contexto Docker activo. Si su VM es Colima con el contexto configurado como en este host, añada `--context colima-crashmemory` entre `docker` y `compose`.

La segunda ejecución de `pnpm db:migrate` responde `Database is up to date`. Cada archivo se aplica bajo advisory lock; un fallo hace rollback y descarta una conexión inutilizable. La migración inicial crea usuarios/sesiones, conexiones y credenciales cifradas, originales/revisiones/cuerpos/adjuntos, blobs, evidencia, obligaciones/versiones/correcciones, cursores, outbox, avisos/intentos y ledgers de uso/auditoría.

Para limpiar sólo el entorno local V02 después de las pruebas:

```bash
docker compose -p crashmemory-v03 \
  -f infra/compose/docker-compose.yml down -v
```

Este último comando elimina la base y el volumen local V02. No es una migración inversa ni debe apuntar a otro proyecto Compose.

## Autenticación compatible V02

No existe registro público. Cree un usuario sintético leyendo la contraseña desde el entorno del proceso; el seed no imprime ni guarda la contraseña en Git:

```bash
DATABASE_URL=postgresql://crashmemory:crashmemory@127.0.0.1:54330/crashmemory_v02 \
SEED_EMAIL=person@example.test \
SEED_PASSWORD='use-a-local-password-of-at-least-12-characters' \
SEED_TIME_ZONE=America/Bogota \
  pnpm db:seed
```

Inicie la API persistente en `4311`:

```bash
API_PORT=4311 \
APP_ENV=local \
APP_ORIGIN=http://127.0.0.1:3001 \
APP_SESSION_COOKIE_NAME=crashmemory_v02_session \
APP_SESSION_COOKIE_SECURE=false \
DATABASE_URL=postgresql://crashmemory:crashmemory@127.0.0.1:54330/crashmemory_v02 \
  pnpm --filter @crashmemory/api demo
```

`POST /api/v1/auth/login` recibe JSON `{ "email", "password" }`; devuelve el usuario, expiración y token CSRF, además de una cookie opaca `HttpOnly`, `SameSite=Lax`, `Path=/`. `POST /api/v1/auth/logout` exige esa cookie, `Content-Type: application/json`, cuerpo `{}` y el header `X-CSRF-Token`. En HTTPS no fije `APP_SESSION_COOKIE_SECURE=false`; el valor predeterminado es seguro.

Las mutaciones con `Origin` sólo aceptan `APP_ORIGIN`. La web evita CORS mediante el rewrite de mismo origen `/api/*` hacia `API_INTERNAL_URL` (por defecto `http://127.0.0.1:4310`; para este worktree use `4311`). La API no habilita CORS con credenciales para orígenes comodín.

La demo sintética de V01 sigue disponible sin DB en `API_PORT=4310 pnpm demo`, con `/healthz`, `/api/v1/contracts` y `/api/v1/demo/obligations`. Sin `DATABASE_URL`, las rutas auth responden `503` en vez de crear sesiones en memoria.

Para abrir el esqueleto web usando el proxy de mismo origen de este worktree:

```bash
WEB_PORT=3001 API_INTERNAL_URL=http://127.0.0.1:4311 \
  pnpm --filter @crashmemory/web dev
```

Con la demo V01 en `4310`, cambie sólo `API_INTERNAL_URL` a `http://127.0.0.1:4310`.

## Claves y secretos

Las contraseñas usan scrypt versionado (`N=16384`, `r=8`, `p=5`) con sal aleatoria. Las sesiones guardan sólo SHA-256 del token opaco y son revocables. Las credenciales de proveedor se cifran con AES-256-GCM, AAD ligado a `userId:sourceConnectionId` y keyring versionado; las llaves se inyectan fuera de Git:

```dotenv
CREDENTIAL_ACTIVE_KEY_VERSION=v1
CREDENTIAL_ENCRYPTION_KEYS_JSON={"v1":"BASE64_DE_32_BYTES"}
OAUTH_STATE_SECRET_BASE64=BASE64_DE_32_BYTES_O_MAS
```

`.env.example` deja esas variables vacías. El estado OAuth firmado sólo admite rutas locales, incluye usuario y sesión, y usa un nonce persistido que se consume atómicamente una sola vez. V04 usa esa primitiva tanto en el inicio como en el callback Gmail. Los logs Fastify redactan cookies, autorización, contraseñas, tokens y ciphertext; no registran cuerpos de solicitudes.

## Modelo persistente

Las relaciones sensibles usan FKs compuestas con `user_id`. Un ID válido de otro usuario no puede asociarse a una conexión, blob, revisión, adjunto, evidencia, versión, corrección, aviso, intento, nonce o asiento de auditoría. Las claves de objetos son globalmente únicas y el repositorio exige el prefijo `users/<userId>/`.

`numeric` conserva hasta 38 dígitos totales y 18 decimales sin redondear; `NaN` e infinitos se rechazan. Las APIs usan cadenas decimales. Un vencimiento civil conserva `date` y zona IANA separados de un instante. Revisiones, cuerpos, adjuntos, evidencia, versiones, intentos y asientos son append-only frente a `UPDATE`; el borrado en cascada por dueño queda disponible para el ciclo de vida V09.

La frontera aditiva [entrada persistida de extracción](docs/contracts/extraction-input-v1.md) fija la revisión → cuerpo normalizado + adjuntos tipados que V04 producirá y V05 consumirá. Un PDF de evidencia debe pertenecer al mismo usuario y revisión.

## Verificación V02 integrada

Con PostgreSQL V02 saludable se ejecutó:

```bash
TEST_DATABASE_URL=postgresql://crashmemory:crashmemory@127.0.0.1:54330/crashmemory_v02 \
  pnpm check
pnpm build
pnpm audit
```

`pnpm check` ejecuta lint, formato, tipos, scanner de secretos y 17 pruebas: contratos, dinero/fecha, cifrado, redacción, serialización segura de logs, estado OAuth, recuperación de migración fallida, repositorios reales con dos usuarios y login/logout real con origen y CSRF. La prueba OAuth altera un byte de la firma decodificada, por lo que siempre verifica un token criptográficamente distinto. Las pruebas DB rechazan asociación cruzada aunque los IDs ajenos existan y comprueban la inmutabilidad de evidencia. `pnpm build` incluye Next.js y `pnpm audit` terminó sin vulnerabilidades conocidas.

CI levanta PostgreSQL `17.6-alpine`, Redis `8.4.0-alpine` y MinIO, e inyecta las variables `TEST_DATABASE_URL`, `TEST_REDIS_URL` y `TEST_OBJECT_STORAGE_*`; así ejecuta las integraciones V03 sin skips. La tarea Turbo de tests no usa caché, por lo que un resultado anterior sin DB no puede reutilizar pruebas omitidas.

También se ejecutaron web `3001` y API `4311` en paralelo: `GET http://127.0.0.1:3001/api/v1/contracts` atravesó el rewrite de mismo origen y devolvió `200` con `X-CrashMemory-Contract: 2026-09-20.v1`.

## Runtime durable V03

La migración `0002_v03_durable_runtime.sql` registra cada intento de despacho y un recibo durable por `(consumer_name, event_id)`. El relé confirma el enqueue en PostgreSQL sólo después de que BullMQ acepta el job. Que Redis pierda sus datos no marca ningún evento como procesado: al arrancar, worker y scheduler recorren PostgreSQL por páginas y recrean jobs con nuevos IDs recuperables.

Un consumidor de efecto de base de datos aplica el cambio y marca el recibo `completed` en una transacción. Si el proceso cae antes del ACK de BullMQ, el replay ve el recibo y no repite el efecto. Un tipo aún no implementado no tiene handler: falla visiblemente en BullMQ y puede recuperarse cuando V05/V06/V07 registre su consumidor real.

ObjectStorage usa claves `users/<uuid>/blobs/<uuid>`. La lectura comprueba dueño, namespace, tamaño y SHA-256 contra el blob de PostgreSQL. Escrituras concurrentes se serializan por blob con advisory lock; una violación determinista de DB limpia el objeto recién creado, y una pérdida de conexión deja un huérfano explícito para limpieza posterior antes que arriesgar borrar bytes que pudieran haberse confirmado.

Para operar el dispatcher y worker, con PostgreSQL y Redis ya levantados, ejecute en terminales distintas:

```bash
DATABASE_URL=postgresql://crashmemory:crashmemory@127.0.0.1:54331/crashmemory_v03 \
REDIS_URL=redis://127.0.0.1:6391 \
  pnpm --filter @crashmemory/scheduler dev

DATABASE_URL=postgresql://crashmemory:crashmemory@127.0.0.1:54331/crashmemory_v03 \
REDIS_URL=redis://127.0.0.1:6391 \
  pnpm --filter @crashmemory/worker dev
```

Ambos emiten JSON sin payloads: `outbox.dispatch.enqueued`, `outbox.dispatch.failed`, `consumer.completed`, `consumer.skipped` y `consumer.unregistered` están en el campo `metrics`; fallas de worker o scheduler incluyen sólo el componente y código. El scheduler despacha cada `OUTBOX_DISPATCH_INTERVAL_MS` (predeterminado `5000`, mínimo `250`), y ambos cierran conexiones limpiamente ante `SIGINT` o `SIGTERM`.

Para revisar un job fallido o forzar un replay no borre filas de PostgreSQL: corrija primero el consumidor/configuración y reinicie worker o scheduler. El arranque ejecuta recovery desde outbox. `outbox_events.last_error_code`, `outbox_dispatch_attempts` y `event_consumer_receipts` guardan el diagnóstico y estado durables; Redis puede limpiarse y el scheduler reconstruirá los jobs.

La prueba V03 validada en este worktree usa servicios propios `crashmemory-v03`:

```bash
COMPOSE_PROJECT_NAME=crashmemory-v03 POSTGRES_PORT=54331 POSTGRES_DB=crashmemory_v03 \
REDIS_PORT=6391 MINIO_PORT=9013 MINIO_CONSOLE_PORT=9014 \
  docker --context colima-crashmemory compose -f infra/compose/docker-compose.yml up -d --wait

TEST_DATABASE_URL=postgresql://crashmemory:crashmemory@127.0.0.1:54331/crashmemory_v03 \
TEST_REDIS_URL=redis://127.0.0.1:6391 \
TEST_OBJECT_STORAGE_ENDPOINT=http://127.0.0.1:9013 \
TEST_OBJECT_STORAGE_BUCKET=crashmemory-v03-test \
TEST_OBJECT_STORAGE_ACCESS_KEY=crashmemory \
TEST_OBJECT_STORAGE_SECRET_KEY=crashmemory-local-only \
  pnpm --filter @crashmemory/runtime test
```

Las nueve pruebas cubren commit→fallo de enqueue→replay, flush de Redis→recovery, caída entre efecto DB/ACK sin duplicar, dos workers, cursor con microsegundos, evento canónico rehidratado desde PostgreSQL, namespace/hash/bytes y MinIO real.

## Límites actuales

V04 no implementa registro/recuperación de contraseña, extracción, reconciliación, Telegram, borrado/exportación ni pantallas de gestión. ObjectStorage persiste originales autorizados, pero V09 define el borrado y barreras contra resurrección. No hay garantía exactly-once para HTTP externo: V07 persistirá intentos antes de Telegram y resolverá la ambigüedad como `unknown`.

La [decisión de modelo remoto y privacidad](docs/adr/0002-remote-model-privacy.md) fija para V05 `gpt-5.6-terra` configurable con esfuerzo `medium`, `store: false`, confirmación explícita del proyecto y bloqueo total de red para `local-only`. Distingue la política de no entrenamiento de la retención de monitoreo de abuso y no presume ZDR.

## Estado

| Hito    | Resultado                                                             | Estado                                                |
| ------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| V01     | Contratos, demo, monorepo, Compose y CI                               | Integrada en `origin/main` (`48cd329`); CI `SUCCESS`. |
| V02     | Memoria segura, repositorios y autenticación                          | Integrada en `origin/main` (`597fd87`).               |
| V03     | Runtime durable                                                       | Integrada en `origin/main` (`c098b6d`).               |
| V04     | OAuth Gmail, MIME/PDF, sync recuperable y webhook Pub/Sub             | En validación para integración.                       |
| V05–V10 | Extracción, reconciliación, Telegram, web, ciclo de vida y validación | Pendiente.                                            |

## Gmail V04

Registre en Google Cloud una URI de redirección exacta que termine en `/api/v1/gmail/callback`. Configure únicamente el scope `https://www.googleapis.com/auth/gmail.readonly`; este proyecto no solicita `modify` ni `mail.google.com`. Mantenga el cliente OAuth, el keyring de credenciales y la clave de estado fuera de Git:

```dotenv
GMAIL_CLIENT_ID=outside-git
GMAIL_CLIENT_SECRET=outside-git
GMAIL_REDIRECT_URI=http://127.0.0.1:4314/api/v1/gmail/callback
CREDENTIAL_ACTIVE_KEY_VERSION=v1
CREDENTIAL_ENCRYPTION_KEYS_JSON={"v1":"base64-32-byte-key"}
OAUTH_STATE_SECRET_BASE64=base64-32-byte-key
GOOGLE_PUBSUB_AUDIENCE=expected-push-oidc-audience
GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL=pubsub-push@project.iam.gserviceaccount.com
GMAIL_PUBSUB_TOPIC=projects/project/topics/crashmemory-gmail
GMAIL_SYNC_ENABLED=true
```

Con una sesión local ya iniciada, `POST /api/v1/gmail/connect` exige `Origin`, `Content-Type: application/json` y `X-CSRF-Token`; devuelve una URL de consentimiento de Google con `prompt=consent` para obtener un refresh token también al reconectar. El callback exige además la misma cookie de sesión activa que emitió el estado firmado, antes de consumir su nonce. Las credenciales se cifran vinculadas a usuario y conexión. Un `invalid_grant`, la expiración de un refresh token de una app en modo testing o una revocación dejan la conexión en error y requieren volver a autorizarla.

El conector limita el bootstrap a 200 mensajes. Captura el `historyId` antes del histórico y hace catch-up después; cada página persiste revisiones, cuerpo normalizado UTF-8, adjuntos y el evento `source.item.revision.created.v1` en una transacción antes de confirmar el cursor. Replays y notificaciones reordenadas son seguros. Un HTTP 404 de `history.list` marca un resync explícito y nunca expande la ventana autorizada en silencio. El watch se debe renovar a diario; el polling incremental desde el cursor confirmado queda como respaldo para avisos perdidos.

El webhook `POST /webhooks/google/gmail` acepta una notificación Pub/Sub sólo con OIDC cuyo `aud` coincide con `GOOGLE_PUBSUB_AUDIENCE`, cuyo emisor es Google y cuyo correo verificado coincide con `GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL`. Persiste la señal `historyId` como disparador durable y no mueve `sync_cursors`; únicamente el catch-up que ya guardó todas sus páginas puede hacerlo. Configure en Pub/Sub la misma audiencia y la URL pública HTTPS del webhook. El cuerpo de un correo, adjuntos y tokens no se registran en logs.

El scheduler ejecuta el conector real cuando `GMAIL_SYNC_ENABLED=true`: descifra el refresh token, obtiene un access token, consume wakeups, hace polling incremental de respaldo, recupera un `historyId` vencido con resync limitado y renueva watch durante las 48 horas previas a su expiración. `GMAIL_SYNC_INTERVAL_MS` predetermina cinco minutos; el watch se renueva diariamente bajo esa política. Si Google devuelve `invalid_grant`, conserva el wakeup y deja la conexión en `error` para que el usuario la vuelva a autorizar.

La verificación V04 se ejecutó con PostgreSQL aislado en `54332`:

```bash
COMPOSE_PROJECT_NAME=crashmemory-v04 POSTGRES_PORT=54332 POSTGRES_DB=crashmemory_v04 \
REDIS_PORT=6392 MINIO_PORT=9015 MINIO_CONSOLE_PORT=9016 \
  docker --context colima-crashmemory compose -f infra/compose/docker-compose.yml up -d postgres --wait

TEST_DATABASE_URL=postgresql://crashmemory:crashmemory@127.0.0.1:54332/crashmemory_v04 \
  pnpm --filter @crashmemory/db test
TEST_DATABASE_URL=postgresql://crashmemory:crashmemory@127.0.0.1:54332/crashmemory_v04 \
  pnpm --filter @crashmemory/api test
TEST_DATABASE_URL=postgresql://crashmemory:crashmemory@127.0.0.1:54332/crashmemory_v04 \
  pnpm --filter @crashmemory/gmail test
```
