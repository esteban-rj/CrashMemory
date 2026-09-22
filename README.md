# CrashMemory — Extracción verificable V05

CrashMemory implementa el flujo Gmail → obligaciones con evidencia → avisos por Telegram. V05 añade ModelGateway, presupuesto duradero y extracción de candidatos verificables desde cuerpo/PDF de texto. Gmail, reconciliación y Telegram aún no están conectados entre sí.

## Requisitos

- Node `24.14.1` y pnpm `11.25.0`.
- Docker Compose para migraciones y pruebas de integración. En este host se comprobó con el contexto `colima-crashmemory`.

Instale exactamente el lockfile antes del primer arranque:

```bash
pnpm install --frozen-lockfile
```

## Base local aislada

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

## Usuario local y login

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

`.env.example` deja esas variables vacías. El estado OAuth firmado sólo admite rutas locales, incluye usuario y sesión, y usa un nonce persistido que se consume atómicamente una sola vez. V04 conectará esta primitiva al callback Gmail. Los logs Fastify redactan cookies, autorización, contraseñas, tokens y ciphertext; no registran cuerpos de solicitudes.

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

## Extracción V05, privacidad y coste

`@crashmemory/extraction` consume la [entrada persistida de extracción](docs/contracts/extraction-input-v1.md): cuerpo normalizado y adjuntos del mismo usuario y revisión. Sólo considera PDF con texto; `parseTextPdf` extrae streams simples por página. Un PDF escaneado, cifrado o no compatible devuelve `pdf_requires_manual_review`; V05 no ofrece OCR ni crea una obligación a partir de ese resultado.

Cada candidato requiere título, importe positivo con moneda ISO, vencimiento y offsets UTF-16. Esos offsets se verifican de nuevo contra el texto y SHA-256 exactos antes de generar evidencia. Un `$` sin moneda, JSON inválido, evidencia fuera de rango o ambigüedad pasa a revisión manual. El correo/PDF se delimita como dato no confiable: sus instrucciones no alteran el prompt ni se aceptan como evidencia.

`local-only` nunca crea una solicitud HTTP, incluso si falla su adaptador local. `remote-allowed` queda bloqueado hasta que un `.env` ignorado contenga `MODEL_REMOTE_ENABLED=true`, `MODEL_PROJECT_DATA_CONTROLS_CONFIRMED=true` y una clave. La confirmación registra que el proyecto API no tiene opt-in de compartición o entrenamiento. El adaptador sólo acepta OpenAI Responses con `gpt-5.6-terra`, esfuerzo `medium`, `store:false`, una llamada foreground y sin fallback ni reintentos ocultos. `store:false` no implica Zero Data Retention: CrashMemory no afirma ZDR; los controles de retención/monitoreo de abuso se administran aparte conforme al [ADR 0002](docs/adr/0002-remote-model-privacy.md).

`DurableExtractionRunner` reclama un `extraction_job`, carga sólo la revisión autorizada, ejecuta el modelo fuera de transacciones y, al terminar, persiste páginas PDF, evidencia y candidatos junto con el evento `obligation.candidate.created.v1`. V06 consume esos candidatos; no se confirma ninguna obligación en V05.

Antes de cada petición remota, `ModelBudgetRepository.reserve` bloquea el presupuesto USD y reserva el máximo del JSON completo enviado (instrucciones, documento y esquema), limitado por `MODEL_MAX_INPUT_TOKENS` y `MODEL_MAX_OUTPUT_TOKENS`. Las tarifas por millón son versionadas y configurables. La respuesta con uso queda `estimated`; sin uso se conserva la estimación conservadora. Un timeout o fallo de transporte queda `unknown` y mantiene su reserva, nunca se muestra como coste cero. El ledger guarda sólo proveedor, modelo, versión, unidades y coste; no guarda correo, PDF, prompt, respuesta ni credencial.

El presupuesto se configura mediante la API de código `new ModelBudgetRepository(pool).setLimit(...)`; aún no existe endpoint HTTP. Con el PostgreSQL aislado de este worktree, compruebe el presupuesto/ledger y los perfiles sin enviar datos ni necesitar clave API:

```bash
TEST_DATABASE_URL=postgresql://crashmemory:crashmemory@127.0.0.1:54331/crashmemory_v03 \
  pnpm --filter @crashmemory/db test

pnpm --filter @crashmemory/model-gateway test
pnpm --filter @crashmemory/extraction test
```

## Límites actuales

V05 no implementa OCR, ZDR, precios facturados del proveedor, ruta local de producción ni endpoint HTTP de presupuesto. Tampoco implementa OAuth Gmail, reconciliación, Telegram, borrado/exportación o pantallas de gestión. ObjectStorage persiste originales autorizados, pero V09 define el borrado y barreras contra resurrección.

La [decisión de modelo remoto y privacidad](docs/adr/0002-remote-model-privacy.md) fija para V05 `gpt-5.6-terra` configurable con esfuerzo `medium`, `store: false`, confirmación explícita del proyecto y bloqueo total de red para `local-only`. Distingue la política de no entrenamiento de la retención de monitoreo de abuso y no presume ZDR.

## Estado

| Hito    | Resultado                                                    | Estado                                                |
| ------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| V01     | Contratos, demo, monorepo, Compose y CI                      | Integrada en `origin/main` (`48cd329`); CI `SUCCESS`. |
| V02     | Memoria segura, repositorios y autenticación                 | Integrada en `origin/main` (`597fd87`).               |
| V03     | Runtime durable                                              | Integrada en `origin/main` (`c098b6d`).               |
| V04     | Gmail                                                        | En desarrollo.                                        |
| V05     | ModelGateway, presupuesto, parsers y candidatos verificables | En validación para integración.                       |
| V06–V10 | Reconciliación, Telegram, web, ciclo de vida y validación    | Pendiente.                                            |
