# CrashMemory — guía de despliegue completo

MVP 1: Gmail → obligaciones con evidencia → Telegram y web de gestión. Siga el orden; la referencia avanzada está al final. Sustituya `cerebro.example.com` y los marcadores `<...>`. El presupuesto debe existir antes de conectar Gmail.

## 1. Preparar equipo y dominio

Necesita Git, OpenSSL, Bash/Zsh y Docker con Compose V2. No necesita Node/pnpm en el host para el arranque ni presupuesto/avisos. Instale [Docker Engine](https://docs.docker.com/engine/install/) en Linux o Docker Desktop en macOS; también sirve Colima.

```bash
docker version
docker compose version
docker context show
git clone https://github.com/esteban-rj/CrashMemory.git
cd CrashMemory
cp .env.example .env
chmod 600 .env
```

Si ya tiene el repo, entre en su raíz y conserve .env; no sobrescriba credenciales. Ejecute lo siguiente desde esa raíz.

Gmail push necesita HTTPS público estable. Esta guía usa equipo siempre encendido, IP pública y dominio propio:

1. En DNS cree registro A para `cerebro.example.com` hacia la IP pública. Añada AAAA sólo si IPv6 llega al mismo equipo.
2. Abra TCP 80/443 en firewall y rediríjalos en su router hacia Docker si corresponde. Con CGNAT necesitará otro host público o un túnel estable configurado por su operador.
3. Reserve esos puertos para Caddy; las bases de datos y puertos internos permanecen en localhost.
4. Compruebe `nslookup cerebro.example.com` y use ese dominio exactamente igual en Google y .env.

Caddy obtiene/renueva certificados con DNS y conectividad correctos. [HTTPS automático](https://caddyserver.com/docs/automatic-https). La alternativa localhost sólo prueba arranque, no completa Pub/Sub.

## 2. Google Cloud y OAuth Gmail

En [Google Cloud Console](https://console.cloud.google.com/), con permisos de administración:

1. Selector de proyecto → Nuevo proyecto → CrashMemory. Anote ID y número del proyecto; son distintos. Use el mismo proyecto en OAuth y Pub/Sub.
2. APIs y servicios → Biblioteca: habilite Gmail API y Cloud Pub/Sub API. Si pide facturación, vincule cuenta y configure alertas de presupuesto.
3. Google Auth Platform → Branding → Comenzar: nombre, correo de soporte/contacto y dominio autorizado cuando lo solicite.
4. Audience / Público: para Gmail personal elija External, Testing y añada su Gmail a Test users. Internal sólo aplica a la misma organización Workspace.
5. Data Access → Añadir permisos: únicamente `https://www.googleapis.com/auth/gmail.readonly`.
6. Clients → Crear cliente → Aplicación web. Origen JavaScript autorizado `https://cerebro.example.com`; redirección autorizada `https://cerebro.example.com/api/v1/gmail/callback`, sin barra final.
7. Copie Client ID y Client secret a GMAIL_CLIENT_ID y GMAIL_CLIENT_SECRET en .env. No necesita clave API Google ni contraseña de aplicación Gmail.

Los menús varían por idioma. [Consentimiento/scopes](https://developers.google.com/workspace/guides/configure-oauth-consent), [cliente web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).

Testing externo hace expirar el refresh token Gmail a los siete días: deberá reconectar. Para uso permanente revise Audience → Publish app y verificación del scope restringido Gmail. Publicar no equivale a verificación ni evita otras revocaciones. La distribución pública requiere la verificación aplicable; Workspace puede requerir aprobación administrativa. [Caducidad](https://developers.google.com/identity/protocols/oauth2), [publicación/verificación](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview).

## 3. Pub/Sub: tema, identidad y suscripción

1. Pub/Sub → Topics → Crear tema, ID `crashmemory-gmail`. Desmarque suscripción predeterminada; no configure esquema.
2. Tema → Permissions → Grant access: principal `gmail-api-push@system.gserviceaccount.com`, rol Pub/Sub Publisher sobre ese tema.
3. Copie `projects/<PROJECT_ID>/topics/crashmemory-gmail` a GMAIL_PUBSUB_TOPIC. Debe pertenecer al proyecto OAuth. Si la organización bloquea al principal Gmail, solicite la excepción al administrador. [Gmail push](https://developers.google.com/workspace/gmail/api/guides/push).
4. IAM y administración → Cuentas de servicio → Crear, ID `crashmemory-pubsub-push`. No asigne Editor ni cree claves JSON.
5. Copie `crashmemory-pubsub-push@<PROJECT_ID>.iam.gserviceaccount.com` a GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL.
6. Quien creará la suscripción necesita iam.serviceAccounts.actAs sobre esa cuenta, incluido en Service Account User.
7. El agente `service-<PROJECT_NUMBER>@gcp-sa-pubsub.iam.gserviceaccount.com` necesita iam.serviceAccounts.getOpenIdToken sobre la cuenta push; puede conceder Service Account Token Creator sobre esa cuenta. No es el principal Gmail.

Si el agente no aparece, en Cloud Shell sustituya valores y ejecute:

```bash
PROJECT_ID='<id-del-proyecto>'
PROJECT_NUMBER='<numero-del-proyecto>'
PUSH_SA="crashmemory-pubsub-push@$PROJECT_ID.iam.gserviceaccount.com"
gcloud beta services identity create --service=pubsub.googleapis.com --project="$PROJECT_ID"
gcloud iam service-accounts add-iam-policy-binding "$PUSH_SA" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:service-$PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role=roles/iam.serviceAccountTokenCreator
```

La API valida firma, emisor, audiencia y correo verificado. [Push autenticado e IAM](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions).

Pub/Sub → Subscriptions → Crear suscripción:

| Campo              | Valor                                               |
| ------------------ | --------------------------------------------------- |
| ID                 | `crashmemory-gmail-push`                            |
| Tema               | `projects/<PROJECT_ID>/topics/crashmemory-gmail`    |
| Entrega            | Push                                                |
| Endpoint           | `https://cerebro.example.com/webhooks/google/gmail` |
| Autenticación      | Activada                                            |
| Cuenta             | `crashmemory-pubsub-push`                           |
| Audience           | `https://cerebro.example.com/webhooks/google/gmail` |
| Payload unwrapping | Desactivado: la API necesita el sobre JSON          |

Guarde. El endpoint estará disponible al arrancar; no conecte Gmail aún. Use idéntica audiencia en .env, no localhost ni el callback OAuth. [Crear suscripción](https://docs.cloud.google.com/pubsub/docs/create-push-subscription).

## 4. Telegram: crear bot

1. Abra [@BotFather](https://t.me/BotFather), la cuenta oficial, y envíe `/newbot`.
2. Elija nombre y username disponible terminado en bot.
3. Copie token a TELEGRAM_BOT_TOKEN en .env y conserve `https://t.me/<username>`.
4. Dedique el bot a esta instalación: sin otro consumidor, webhook, grupos ni administración.
5. El paso 9 vincula su chat privado mediante código temporal.

Se usa polling getUpdates: no necesita webhook Telegram ni TELEGRAM_CHAT_ID manual. Un webhook previo bloquea polling; el paso 9 permite retirarlo. [BotFather](https://core.telegram.org/bots/tutorial), [polling](https://core.telegram.org/bots/faq).

## 5. OpenAI: clave y privacidad

1. En [OpenAI Platform](https://platform.openai.com/) cree/seleccione proyecto dedicado.
2. Configure facturación API y límites/alertas; el presupuesto local del paso 8 es adicional.
3. Settings → Organization → Data controls: compruebe que compartir entradas/salidas, evaluaciones y otros datos para mejora de modelos esté desactivado para ese proyecto. Si no tiene permisos solicítelo al propietario.
4. En API keys cree una clave del proyecto con acceso a Responses API; guárdela en MODEL_API_KEY. [Primeros pasos](https://developers.openai.com/api/docs/quickstart).
5. Mantenga MODEL_NAME=gpt-5.6-terra y MODEL_REASONING_EFFORT=medium. Es la combinación admitida; compruebe acceso en su proyecto. Otra causa remote_model_incompatible y requiere cambiar el adaptador. [Modelo](https://developers.openai.com/api/docs/models/gpt-5.6-terra).
6. Revise tarifas vigentes y MODEL_PRICING_VERSION, MODEL_INPUT_USD_PER_MILLION y MODEL_OUTPUT_USD_PER_MILLION; la plantilla contiene una base conservadora versionada, no su factura.

La API no usa datos para entrenamiento por defecto salvo consentimiento explícito. El texto correo/PDF sí sale al proveedor. `store:false` no equivale a Zero Data Retention; puede aplicar retención de monitoreo de abuso. ZDR requiere elegibilidad/aprobación. Marque MODEL_PROJECT_DATA_CONTROLS_CONFIRMED=true sólo tras verificar: la variable no configura al proveedor. [Controles de datos](https://developers.openai.com/api/docs/guides/your-data).

## 6. Completar .env y claves

Edite .env; no ejecute `source .env`. Conserve las demás variables de la plantilla y complete:

| Variables                                                | Valor                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| APP_ORIGIN / APP_SESSION_COOKIE_SECURE                   | `https://cerebro.example.com` / `true`                              |
| SEED_EMAIL / SEED_PASSWORD / SEED_TIME_ZONE              | Login local, contraseña larga, America/Bogota o su zona IANA        |
| COMPOSE_PROJECT_NAME / POSTGRES_DB                       | crashmemory en ambas                                                |
| POSTGRES_PASSWORD                                        | Contraseña nueva, preferiblemente hexadecimal                       |
| DATABASE_URL                                             | `postgresql://crashmemory:<contraseña>@127.0.0.1:54329/crashmemory` |
| DOCKER_DATABASE_URL                                      | `postgresql://crashmemory:<contraseña>@postgres:5432/crashmemory`   |
| MINIO_ROOT_USER / OBJECT_STORAGE_ACCESS_KEY              | crashmemory-storage en ambas                                        |
| MINIO_ROOT_PASSWORD / OBJECT_STORAGE_SECRET_KEY          | Otra contraseña nueva igual en ambas                                |
| OBJECT_STORAGE_BUCKET                                    | crashmemory                                                         |
| CREDENTIAL_ACTIVE_KEY_VERSION                            | v1                                                                  |
| CREDENTIAL_ENCRYPTION_KEYS_JSON                          | `'{"v1":"<clave-base64-1>"}'`                                       |
| OAUTH_STATE_SECRET_BASE64                                | Clave base64 2                                                      |
| LIFECYCLE_JOURNAL_KEY_BASE64                             | Clave base64 3                                                      |
| LIFECYCLE_BACKUP_KEY_BASE64                              | Clave base64 4                                                      |
| LIFECYCLE_JOURNAL_DIR                                    | Ruta absoluta privada fuera del checkout y backups                  |
| LIFECYCLE_JOURNAL_PATH                                   | Esa ruta seguida de /journal.log                                    |
| GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET                    | Paso 2                                                              |
| GMAIL_REDIRECT_URI                                       | `https://cerebro.example.com/api/v1/gmail/callback`                 |
| GMAIL_PUBSUB_TOPIC / GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL | Paso 3                                                              |
| GOOGLE_PUBSUB_AUDIENCE                                   | `https://cerebro.example.com/webhooks/google/gmail`                 |
| TELEGRAM_BOT_TOKEN / MODEL_API_KEY                       | Pasos 4 y 5                                                         |

Mantenga inicialmente GMAIL_SYNC_ENABLED, MODEL_REMOTE_ENABLED, MODEL_PROJECT_DATA_CONTROLS_CONFIRMED y NOTIFICATIONS_AUTOMATIC_ENABLED en false, EXTRACTION_DEFAULT_PRIVACY_PROFILE=local-only. Deje puertos/direcciones host de la plantilla: API 4310, web 3000, PostgreSQL 54329, Redis 6389, MinIO 9009/9010. Compose sustituye las direcciones internas.

Genere cada secreto por separado:

```bash
openssl rand -hex 24
openssl rand -base64 32
```

Use hexadecimal para contraseñas; segunda orden cuatro veces para las cuatro claves de 32 bytes independientes. Con otra contraseña PostgreSQL aplique percent-encoding en ambas URL conservando la original en POSTGRES_PASSWORD. Encierre valores con `$` o `#` en comillas simples.

Cree journal con su ruta real:

```bash
mkdir -p /ruta/absoluta/privada/crashmemory-journal
chmod 700 /ruta/absoluta/privada/crashmemory-journal
```

Autorice compartirlo con Docker Desktop si se solicita. Conserve claves/journal, no regenere al arrancar. Login local puede diferir de Gmail. Seed crea cuenta una vez: cambiar SEED_PASSWORD no cambia una contraseña existente.

## 7. Arrancar Docker y HTTPS

Defina función en cada terminal nueva:

```bash
dc() {
  docker compose --env-file .env \
    -f infra/compose/docker-compose.yml \
    -f infra/compose/docker-compose.app.yml \
    -f infra/compose/docker-compose.https.yml "$@"
}
dc config --quiet
dc up -d --build --wait
dc ps -a
dc logs --tail=50 migrate seed bucket caddy
```

Con Colima use `docker --context colima-crashmemory compose` dentro de la función. Para sólo localhost quite tercer -f, APP_ORIGIN=http://127.0.0.1:3000, callback con ese origen y APP_SESSION_COOKIE_SECURE=false.

Resultado: migrate/seed/bucket terminan código 0; PostgreSQL, Redis, MinIO, API y web healthy; worker, scheduler y Caddy activos. Seed muestra UUID. Abra dominio HTTPS, compruebe certificado e ingrese con SEED_EMAIL/SEED_PASSWORD.

Desde red externa:

```bash
curl -I https://cerebro.example.com/
curl -i -X POST https://cerebro.example.com/webhooks/google/gmail \
  -H 'Content-Type: application/json' -d '{}'
```

Web debe responder, POST sin token debe recibir 401. Un 404 de Next indica proxy incorrecto. Healthy no verifica DNS/TLS/proveedores. El [overlay](infra/compose/docker-compose.https.yml) conserva certificados; el [Caddyfile](infra/compose/Caddyfile) dirige webhook a api:4310 y resto a web:3000. Next reescribe /api. No ponga login adicional delante del webhook: Google usa OIDC. [Caddy Compose](https://caddyserver.com/docs/running#docker-compose).

## 8. Presupuesto y habilitación

Obtenga UUID:

```bash
dc logs seed
dc exec -T postgres sh -c \
  'psql -U crashmemory -d "$POSTGRES_DB" -c "SELECT id, email_normalized FROM users;"'
```

Elija límite y período UTC vigente (inicio anterior a ahora, final posterior):

```bash
dc exec -T api pnpm --filter @crashmemory/db budget:set -- \
  --user-id '<UUID>' --limit-usd '5.00' \
  --period-start '<YYYY-MM-DDTHH:mm:ssZ>' \
  --period-end '<YYYY-MM-DDTHH:mm:ssZ>'
dc exec -T api pnpm --filter @crashmemory/db budget:ledger -- \
  --user-id '<UUID>' --limit 25
```

No solape períodos. Al vencer configure otro: no hay renovación automática. Ledger estima costos; un timeout conserva reserva como unknown.

Tras verificar privacidad, cambie .env:

```dotenv
EXTRACTION_DEFAULT_PRIVACY_PROFILE=remote-allowed
MODEL_REMOTE_ENABLED=true
MODEL_PROJECT_DATA_CONTROLS_CONFIRMED=true
GMAIL_SYNC_ENABLED=true
```

```bash
dc up -d --no-deps --force-recreate api worker scheduler
dc ps
dc logs --tail=50 worker scheduler
```

Restart no recarga .env. Local-only no tiene adaptador productivo local y deja revisión manual; cambiar perfil después no garantiza reprocesar lo bloqueado.

## 9. Vincular Telegram y conectar Gmail

1. Abra su bot en chat privado.
2. En Telegram dentro de la web genere código; envíe al bot `/start <código>` mostrado. Caduca en diez minutos, un uso.
3. Espere polling (diez segundos), actualice web y compruebe vínculo. No consulte getUpdates manualmente.
4. En Gmail dentro de la web pulse Conectar Gmail, elija usuario de prueba y autorice lectura.
5. Regrese al mismo dominio. Revise estado/logs scheduler; respaldo cada cinco minutos. Histórico inicial conserva hasta 200 mensajes, incluidos correos personales existentes.
6. En Pub/Sub → suscripción → métricas compruebe entregas sin errores persistentes al recibir correo. CrashMemory crea/renueva watch automáticamente.

Si reutiliza bot con webhook, retírelo antes de generar código nuevo; esto no imprime token ni envía mensajes:

```bash
dc exec -T worker node --input-type=module -e '
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN ausente");
try {
  const response = await fetch("https://api.telegram.org/bot" + token + "/deleteWebhook", { method: "POST" });
  const body = await response.json();
  console.log({ status: response.status, ok: body.ok });
  if (!body.ok) process.exitCode = 1;
} catch { console.error("No se pudo retirar el webhook"); process.exitCode = 1; }
'
```

Sólo para bot dedicado: desactiva su integración webhook anterior. [deleteWebhook](https://core.telegram.org/bots/api#deletewebhook).

## 10. Validar extracción y activar avisos

1. Desde otra cuenta envíe correo sintético al Gmail conectado: «Factura prueba CM-001, pagar COP 10000 el [fecha futura completa] a las [hora] America/Bogota». Deje 20 minutos para revisar.
2. Espere sincronización/extracción. Compruebe obligación, importe, moneda, fecha, evidencia y ledger.
3. Corrija y confirme manualmente. PDF con texto admitido; escaneados/protegidos/ambiguos requieren revisión sin OCR.
4. Tras evaluar calidad ponga NOTIFICATIONS_AUTOMATIC_ENABLED=true en .env. Es global: revise demás obligaciones.
5. Recree y programe futuras confirmadas:

```bash
dc up -d --no-deps --force-recreate worker scheduler
dc exec -T worker pnpm --filter @crashmemory/notifications reminders:backfill
dc logs --tail=50 worker scheduler
```

6. Mantenga equipo/Docker encendidos hasta vencer. Verifique mensaje Telegram e intento sent. Se avisa un día antes y al vencer, no al vincular. No recupera vencimientos históricos; fecha civil sin hora vence a medianoche de su zona.
7. Marque pagada otra obligación futura confirmada para verificar cancelación.

Ante unknown revise Telegram antes de intervenir: no reenvío ciego. Este recorrido valida proveedores reales; pruebas sintéticas no garantizan precisión/entrega.

## 11. Operación y diagnóstico

```bash
dc ps -a
dc logs --tail=100 api worker scheduler
dc stop
dc up -d --wait
```

Stop drena y conserva datos. `dc down` conserva volúmenes/journal; no use `down -v` con datos reales. Para actualizar haga backup según recuperación, luego:

```bash
git pull --ff-only
dc up -d --build --wait
dc ps -a
```

Conserve COMPOSE_PROJECT_NAME. Rotar claves/contraseñas PostgreSQL/MinIO requiere coordinación, no basta editar .env.

| Síntoma                  | Revisar                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| Build/pull               | Red, disco, Docker Hub/GHCR                                         |
| TLS                      | DNS, TCP 80/443, CGNAT, puertos ocupados, logs caddy                |
| Login / 403              | APP_ORIGIN exacto, HTTPS con cookie Secure, API recreada            |
| redirect_uri_mismatch    | Callback idéntico Google/.env                                       |
| Google access_denied     | Test users, publicación, políticas Workspace                        |
| Gmail invalid_grant      | Token expirado/revocado; reconectar                                 |
| Pub/Sub 401/403          | Cuenta/audiencia, actAs, emisión OIDC, Authorization en proxy       |
| Watch denegado           | Topic del proyecto OAuth y Publisher para Gmail                     |
| Webhook 404              | Ruta directa API; Next sólo reescribe /api                          |
| Telegram sin vínculo     | Código vigente, chat privado, token, sin webhook/otro consumidor    |
| Sin extracción           | Perfil, flags, clave, modelo admitido, presupuesto vigente del UUID |
| Sin aviso                | Vínculo, flags, fecha futura, backfill, failed/unknown              |
| Seed password sin efecto | Seed no resetea usuarios; no borre volúmenes                        |
| Healthy sin correos      | Flag Gmail, consentimiento, scheduler, salida HTTPS a proveedores   |

No publique `docker compose config` sin --quiet ni entornos completos: contienen secretos.

## Alternativa de desarrollo en el host

Esta alternativa requiere Node 24.14.1 y pnpm 11.25.0. No es necesaria para los pasos Docker anteriores.

## Ejecución de procesos en el host

Para este modo, active Node y pnpm en las versiones fijadas (Volta puede leer los pines de package.json) e instale el lockfile:

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
```

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

## Exportación, borrado y recuperación

Las rutas de ciclo de vida requieren cookie de sesión, `Origin` confiable, `Content-Type: application/json`, `X-CSRF-Token` y un journal cifrado actual en `LIFECYCLE_JOURNAL_PATH`, fuera del checkout y de los backups. La desconexión Gmail borra la credencial local aun si la revocación remota responde `failed` o `not_configured`. El borrado registra primero la intención; las barreras impiden que un replay o restore anterior resucite lo borrado.

| Operación                        | Ruta                                                                      |
| -------------------------------- | ------------------------------------------------------------------------- |
| Cuenta completa                  | `DELETE /api/v1/lifecycle/account`                                        |
| Fuente Gmail                     | `DELETE /api/v1/lifecycle/sources/:connectionId`                          |
| Mensaje de una fuente            | `DELETE /api/v1/lifecycle/sources/:connectionId/items/:externalMessageId` |
| Obligación conservando el correo | `DELETE /api/v1/lifecycle/obligations/:obligationId`                      |

`GET /api/v1/lifecycle/export?includeOriginals=false` exporta metadatos propios; habilitar originales los incluye en base64 hasta 10 MiB cada uno. Si un crash deja `LIFECYCLE_JOURNAL_PATH.lock`, confirme primero que API, worker, scheduler y cualquier CLI estén detenidos; sólo entonces retire ese directorio y reintente. Nunca elimine el lock mientras exista un escritor.

La CLI de backup/restore actualmente se ejecuta en el host: la imagen de aplicación no incluye pg_dump/pg_restore ni el cliente Docker. Para estas operaciones instale Node 24.14.1 y pnpm 11.25.0, ejecute pnpm install --frozen-lockfile y use las URL host de .env. Configure LIFECYCLE_PG_CONTAINER con el ID mostrado por dc ps -q postgres y LIFECYCLE_DOCKER_CONTEXT con su contexto Docker (por ejemplo colima-crashmemory). Así no necesita instalar PostgreSQL en el host.

Para backup ejecute dc stop api worker scheduler y espere que terminen su drenaje; conserve PostgreSQL, Redis y MinIO encendidos. Cree previamente el directorio privado de destino del backup. Conserve fuera de Git el journal actual, sus claves y el archivo cifrado:

```bash
LIFECYCLE_QUIESCED=true LIFECYCLE_BACKUP_OUTPUT=/secure/crashmemory.enc \
  node scripts/run-local.mjs --filter @crashmemory/lifecycle backup
```

Sin binarios nativos, configure `LIFECYCLE_PG_CONTAINER` con el contenedor PostgreSQL que aloja `DATABASE_URL` y `LIFECYCLE_DOCKER_CONTEXT`. El adaptador transmite el dump por entrada/salida estándar.

Tras un backup correcto, reanude con dc up -d api worker scheduler. Para restaurar, detenga de nuevo los escritores. No ejecute el arranque completo antes del restore: migración y seed harían que el destino dejara de estar vacío.

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
