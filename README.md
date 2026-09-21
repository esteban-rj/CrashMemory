# CrashMemory — Foundation V01

CrashMemory empieza con el flujo Gmail → obligaciones con evidencia → avisos por Telegram. Esta entrega deja el monorepo, los contratos y una demo sintética local. No conecta Gmail, no persiste datos, no autentica usuarios y no envía Telegram todavía.

## Requisitos

- Node `24.14.1` y pnpm `11.25.0` (Corepack).
- Docker Compose es opcional para ejecutar los servicios locales de base. La demo de API no requiere Docker ni credenciales cloud.

## Arranque comprobable

```bash
pnpm install --frozen-lockfile
pnpm demo
```

La demo escucha sólo en `http://127.0.0.1:4310`. En otra terminal, compruebe:

```bash
curl http://127.0.0.1:4310/healthz
curl http://127.0.0.1:4310/api/v1/demo/obligations
```

La primera respuesta es `{ "status": "ok", "mode": "demo" }`. La segunda contiene una única obligación sintética, con importe decimal `"48250.00"`, moneda `COP`, fecha civil en `America/Bogota` y la marca `"synthetic-demo"`; no son datos reales ni persistentes.

El esqueleto web se puede abrir independientemente con `pnpm --filter @crashmemory/web dev` en `http://127.0.0.1:3000`. Muestra que la interfaz todavía es un esqueleto y enlaza a la demo API; las pantallas de gestión llegan en V08. Para aislar otro worktree, fije ambos puertos y el enlace público de la API, por ejemplo: `API_PORT=44310 pnpm demo` y `WEB_PORT=3301 API_BASE_URL=http://127.0.0.1:44310 pnpm --filter @crashmemory/web dev`.

## Servicios locales opcionales

Copie la configuración de ejemplo sólo si va a ejecutar Compose. Los valores incluidos son exclusivos para desarrollo local y no deben reutilizarse fuera de esa máquina.

```bash
cp .env.example .env
docker compose --env-file .env -f infra/compose/docker-compose.yml up -d
docker compose --env-file .env -f infra/compose/docker-compose.yml ps
```

El proyecto Compose se llama `crashmemory-v01` por defecto y publica sólo en loopback: PostgreSQL `127.0.0.1:54329`, Redis `127.0.0.1:6389`, MinIO API `127.0.0.1:9009` y consola `127.0.0.1:9010`. Cambie `COMPOSE_PROJECT_NAME` y los cuatro puertos `*_PORT` de `.env` para otro worktree. Para limpiar únicamente estos volúmenes locales:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml down -v
```

En este host la VM Docker usa el contexto `colima-crashmemory`; selecciónelo sólo si también usa Colima: `docker --context colima-crashmemory compose --env-file .env -f infra/compose/docker-compose.yml ps`.

V01 no crea tablas ni migraciones. V02 añadirá el esquema PostgreSQL; V03 conectará Redis al procesamiento durable y V02/V03 crearán el bucket/almacenamiento cuando exista el adaptador de objetos.

## Verificación

```bash
pnpm check
pnpm build
pnpm audit
```

`pnpm check` verifica estructura, tipos, tests de schemas/API y el escáner de credenciales sobre archivos versionados, staged y sin staging. El escáner incluye una fixture sintética aislada que demuestra detección, sin contener una credencial utilizable. `pnpm build` compila los esqueletos y construye la web. CI ejecuta estos checks y además exige que cada entrega cambie este README frente a su base.

## Contratos de la base

- [Modelo canónico](docs/contracts/canonical-model-v1.md): identidad local separada de OAuth Gmail, dinero, fechas, evidencia, versiones, correcciones, avisos y límites de IA.
- [Contrato HTTP](docs/contracts/http-v1.md): endpoints disponibles y rutas reservadas.
- [Eventos y outbox](docs/contracts/events-v1.md): catálogo versionado y recuperación durable prevista.
- [ERD inicial](docs/contracts/erd-v1.md): pertenencia, inmutabilidad y restricciones que V02 debe preservar.
- [ADR de fundación](docs/adr/0001-foundation-decisions.md): decisiones cerradas para el alcance reducido.

Los schemas Zod ejecutables viven en `@crashmemory/contracts`. Aceptan decimales como cadenas, fechas civiles reales e información de evidencia/eventos versionada; rechazan números flotantes, fechas inválidas, evidencia PDF incompleta y eventos no versionados.

## Estructura

`apps/api` contiene la demo Fastify. `apps/web` es un esqueleto Next.js. `apps/worker` y `apps/scheduler` son puntos de entrada sin procesamiento funcional hasta V03 y V07. `packages/contracts` es el único contrato compartido creado por V01. `infra/compose` contiene PostgreSQL, Redis y MinIO para los siguientes hitos, aislados por proyecto y puertos.

## Límites de seguridad y alcance

No agregue secretos a `.env.example`, código, fixtures, logs ni Git. Use credenciales reales sólo en archivos locales ignorados. La autenticación local definida aquí usará contraseña hasheada y sesión opaca de servidor; es distinta del consentimiento Gmail. Chat, Calendar, gastos, contratos como negocio, OCR, WhatsApp, búsquedas semánticas, grafo y MCP permanecen fuera del MVP 1.

## Estado

| Hito    | Resultado                                                                    | Estado                                                                                       |
| ------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| V01     | Contratos, demo, monorepo, Compose y CI                                      | Lista para integración tras las validaciones registradas en [el acta](docs/sessions/V01.md). |
| V02     | Memoria segura y autenticación                                               | Pendiente.                                                                                   |
| V03     | Runtime durable                                                              | Pendiente.                                                                                   |
| V04–V10 | Gmail, extracción, reconciliación, Telegram, web, ciclo de vida y validación | Pendiente.                                                                                   |
