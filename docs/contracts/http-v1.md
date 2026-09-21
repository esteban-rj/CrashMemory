# Contrato HTTP v1

Prefijo reservado: `/api/v1`. JSON UTF-8; los errores siguen `{ "error": { "code", "message", "requestId" } }` y no incluyen secretos, cuerpos de correo ni tokens. Toda respuesta de dominio lleva `X-CrashMemory-Contract: 2026-09-20.v1` cuando V02 implemente middleware.

| Método y ruta                  | Contrato                                                                               | Estado en V01                 |
| ------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------- |
| `GET /healthz`                 | `{ status: "ok", mode: "demo" }`                                                       | disponible, sin autenticación |
| `GET /api/v1/contracts`        | `{ version }`                                                                          | disponible, sin autenticación |
| `GET /api/v1/demo/obligations` | `{ data: ObligationSummary[], meta: { mode: "synthetic-demo", persistence: "none" } }` | disponible, sin autenticación |
| `POST /api/v1/auth/login`      | credenciales locales; crea sesión opaca                                                | reservado V02                 |
| `POST /api/v1/auth/logout`     | invalida sesión actual                                                                 | reservado V02                 |
| `GET /api/v1/obligations`      | lista sólo del usuario de sesión                                                       | reservado V06                 |
| `GET /api/v1/evidence/:id`     | evidencia/objeto sólo del dueño                                                        | reservado V06                 |
| `POST /api/v1/gmail/connect`   | inicia OAuth del usuario autenticado                                                   | reservado V04                 |
| `POST /api/v1/telegram/link`   | inicia vínculo de bot de un solo uso                                                   | reservado V07                 |

Los endpoints reservados no existen aún. Las mutaciones futuras validan `Content-Type`, schema, sesión, CSRF y pertenencia de todos los IDs antes de leer o escribir.
