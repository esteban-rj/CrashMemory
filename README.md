# CrashMemory — Memoria y seguridad V02

CrashMemory implementa el flujo Gmail → obligaciones con evidencia → avisos por Telegram. V02 añade PostgreSQL, repositorios aislados por usuario y autenticación local a la base sintética de V01. Gmail, extracción, reconciliación y Telegram todavía no están conectados.

## Requisitos

- Node `24.14.1` y pnpm `11.25.0`.
- Docker Compose para migraciones y pruebas de integración. En este host se comprobó con el contexto `colima-crashmemory`.

Instale exactamente el lockfile antes del primer arranque:

```bash
pnpm install --frozen-lockfile
```

## Base local aislada

La configuración de ejemplo reserva el proyecto Compose `crashmemory-v02`, PostgreSQL `54330`, Redis `6390`, MinIO `9011/9012`, API `4311` y web `3001`. Los servicios sólo publican en loopback. Para levantar PostgreSQL y aplicar la migración ejecutada en esta entrega:

```bash
POSTGRES_PORT=54330 POSTGRES_DB=crashmemory_v02 \
  docker compose -p crashmemory-v02 \
  -f infra/compose/docker-compose.yml up -d postgres

DATABASE_URL=postgresql://crashmemory:crashmemory@127.0.0.1:54330/crashmemory_v02 \
  pnpm db:migrate
```

El comando es portable y usa el contexto Docker activo. Si su VM es Colima con el contexto configurado como en este host, añada `--context colima-crashmemory` entre `docker` y `compose`.

La segunda ejecución de `pnpm db:migrate` responde `Database is up to date`. Cada archivo se aplica bajo advisory lock; un fallo hace rollback y descarta una conexión inutilizable. La migración inicial crea usuarios/sesiones, conexiones y credenciales cifradas, originales/revisiones/cuerpos/adjuntos, blobs, evidencia, obligaciones/versiones/correcciones, cursores, outbox, avisos/intentos y ledgers de uso/auditoría.

Para limpiar sólo el entorno local V02 después de las pruebas:

```bash
docker compose -p crashmemory-v02 \
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

## Verificación ejecutada

Con PostgreSQL V02 saludable se ejecutó:

```bash
TEST_DATABASE_URL=postgresql://crashmemory:crashmemory@127.0.0.1:54330/crashmemory_v02 \
  pnpm check
pnpm build
pnpm audit
```

`pnpm check` ejecuta lint, formato, tipos, scanner de secretos y 17 pruebas: contratos, dinero/fecha, cifrado, redacción, serialización segura de logs, estado OAuth, recuperación de migración fallida, repositorios reales con dos usuarios y login/logout real con origen y CSRF. Las pruebas DB rechazan asociación cruzada aunque los IDs ajenos existan y comprueban la inmutabilidad de evidencia. `pnpm build` incluye Next.js y `pnpm audit` terminó sin vulnerabilidades conocidas.

CI levanta PostgreSQL `17.6-alpine`, inyecta `TEST_DATABASE_URL` y ejecuta las mismas integraciones. La tarea Turbo de tests no usa caché, por lo que un resultado anterior sin DB no puede reutilizar pruebas omitidas.

También se ejecutaron web `3001` y API `4311` en paralelo: `GET http://127.0.0.1:3001/api/v1/contracts` atravesó el rewrite de mismo origen y devolvió `200` con `X-CrashMemory-Contract: 2026-09-20.v1`.

## Límites actuales

V02 no implementa registro/recuperación de contraseña, OAuth Gmail ni su callback HTTP, descarga de objetos, extracción, jobs Redis, reconciliación, Telegram, borrado/exportación o pantallas de gestión. MinIO y Redis permanecen disponibles en Compose para sesiones posteriores, pero V02 sólo verificó PostgreSQL. Los originales conservan metadatos de objeto; V03 implementará ObjectStorage y V09 las operaciones de ciclo de vida.

La [decisión de modelo remoto y privacidad](docs/adr/0002-remote-model-privacy.md) fija para V05 `gpt-5.6-terra` configurable con esfuerzo `medium`, `store: false`, confirmación explícita del proyecto y bloqueo total de red para `local-only`. Distingue la política de no entrenamiento de la retención de monitoreo de abuso y no presume ZDR.

## Estado

| Hito    | Resultado                                                                    | Estado                                                        |
| ------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| V01     | Contratos, demo, monorepo, Compose y CI                                      | Integrada en `origin/main` (`48cd329`); CI `SUCCESS`.         |
| V02     | Memoria segura, repositorios y autenticación                                 | Lista para integración según [el acta](docs/sessions/V02.md). |
| V03     | Runtime durable                                                              | Pendiente.                                                    |
| V04–V10 | Gmail, extracción, reconciliación, Telegram, web, ciclo de vida y validación | Pendiente.                                                    |
