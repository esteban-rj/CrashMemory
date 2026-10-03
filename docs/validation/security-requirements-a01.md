# Auditoría A01 — OpenRouter, modelos y permisos

Fecha: 2026-10-03 (America/Bogota). Código auditado: `f5f8397cb025f16f2afaae15fe189bf6a5a467c1`, comprobado en `origin/main`. Alcance: los tres requisitos solicitados, sobre código, configuración de ejemplo, documentación y pruebas. Esta auditoría no certifica una cuenta de proveedor ni un despliegue real.

**Resultado: los tres requisitos no están cumplidos al 100 %.** Los dos primeros requieren OpenRouter, que todavía no está implementado. El tercero se cumple en el scope solicitado explícitamente, pero no garantiza que las credenciales aceptadas tengan únicamente ese permiso.

| Requisito                                                   | Estado                                                                                    | Evidencia principal                                                                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Datos enviados por OpenRouter excluidos de entrenamiento | No implementado para OpenRouter; controles del proveedor actual parcialmente verificables | `packages/model-gateway/src/index.ts:55` fija `openai`; `:169` llama a OpenAI directamente. No existe adaptador OpenRouter ni filtro `data_collection`. |
| 2. Modelos OpenRouter apropiados para la tarea              | No implementado; idoneidad comparativa no demostrada                                      | `packages/model-gateway/src/index.ts:5` fija `gpt-5.6-terra`; `:84` rechaza otro modelo/esfuerzo. Las pruebas de extracción usan `FakeStructuredModel`. |
| 3. Pedir únicamente lectura en servicios del usuario        | Cumple el scope explícito de Gmail; garantía efectiva incompleta                          | `apps/api/src/gmail.ts:91` pide `gmail.readonly`, pero `:93` habilita permisos previos. El intercambio y refresh no validan los permisos concedidos.    |

No se encontró evidencia de que el proveedor actual esté entrenando con estos datos. La ausencia de OpenRouter es una diferencia de implementación respecto de lo solicitado, no prueba de uso indebido por OpenAI.

## 1. Exclusión de entrenamiento

El único adaptador remoto de producción es `OpenAiResponsesAdapter`. El worker lo instancia en `apps/worker/src/worker.ts:71`. `MODEL_PROVIDER=openrouter` no cambia el proveedor: una prueba directa de `loadRemoteModelConfig` con esa variable devolvió `provider: "openai"`.

Hay barreras útiles: `local-only` no recurre a remoto; `remote-allowed` exige habilitación, confirmación operativa, clave y presupuesto; el request contiene `store:false`; no hay fallback automático a otro modelo. Los seis tests de ModelGateway pasan y comprueban esas propiedades con un transporte simulado.

La confirmación `MODEL_PROJECT_DATA_CONTROLS_CONFIRMED=true` es una declaración del operador. No consulta ni cambia controles de cuenta; `store:false` tampoco acredita exclusión de entrenamiento ni ausencia de retención. El ADR 0002 y el README documentan correctamente esta distinción para OpenAI. Sus [controles de datos](https://developers.openai.com/api/docs/guides/your-data) deben comprobarse en el proyecto efectivo antes de habilitarlo.

Para implementar el requisito en OpenRouter, cada solicitud debe restringir los proveedores mediante `provider.data_collection: "deny"`, sin un camino alternativo que omita la restricción. OpenRouter documenta este filtro y sus valores en [selección de proveedores](https://openrouter.ai/docs/guides/routing/provider-selection#requiring-providers-to-comply-with-data-policies).

También debe quedar evidencia operativa de que está desactivada la opción de uso de entradas/salidas en la cuenta/organización efectiva. El logging privado de contenido es un control separado; conviene desactivarlo para minimizar retención, sin equipararlo con entrenamiento. El filtro de proveedores no configura estas opciones. Sus [controles de recopilación](https://openrouter.ai/docs/guides/privacy/data-collection) las distinguen de los metadatos de consumo.

`provider.zdr:true` añade una exigencia de no retención para los endpoints de inferencia; es una restricción adicional, distinta de no entrenamiento. Debe tratarse como una política explícita si se desea exigirla, no como condición ya solicitada o garantía sobre herramientas externas. Véase [ZDR](https://openrouter.ai/docs/guides/features/zdr).

Aceptación pendiente:

1. Implementar y conectar el adaptador OpenRouter, con identificador de proveedor correcto en el ledger y configuración/documentación coherentes.
2. Probar que toda salida, retry y ruta de fallback mantiene la política de privacidad y que no se llama al proveedor cuando falta una ruta permitida.
3. Capturar un request sintético para comprobar endpoint, filtro y ausencia de plugins/herramientas externas no aprobadas.
4. Verificar fuera de Git los controles efectivos de cuenta y la política del endpoint elegido, sin almacenar claves ni contenido personal en el acta.

## 2. Adecuación del modelo a la tarea

La única tarea LLM de producción es extraer candidatos de obligaciones del cuerpo Gmail y del texto de páginas PDF: título, importe/moneda, vencimiento, identidad y offsets de evidencia. Reconciliación y recordatorios usan lógica determinista; no hay chat, OCR ni embeddings implementados que requieran otros modelos.

El modelo actual tiene una justificación general en ADR 0002 y admite salida estructurada según su [ficha oficial](https://developers.openai.com/api/docs/models/gpt-5.6-terra). Eso acredita compatibilidad de características, no que sea la opción más apropiada ni que se haya validado mediante OpenRouter.

Las siete pruebas de `packages/extraction/test/extraction.test.ts` verifican validadores, evidencia, importes, fechas y casos de revisión. Las pruebas que ejercen el servicio reciben respuestas preparadas mediante `FakeStructuredModel`, por ejemplo en `:22`; no miden extracción de un LLM. `docs/validation/mvp1-acceptance.md` y README ya reconocen que no se han medido precisión real ni disponibilidad del modelo. No existe evaluación comparativa documentada entre modelos remotos.

Para una ruta OpenRouter se debe comprobar el soporte efectivo de JSON Schema estricto, el contexto suficiente, límites de salida y política de datos de cada endpoint. `provider.require_parameters:true` permite excluir rutas que ignoren parámetros requeridos, según [salidas estructuradas](https://openrouter.ai/docs/guides/features/structured-outputs). La recomendación es elegir dentro de modelos que hayan superado evaluación, sin selección automática abierta a todo el catálogo.

Aceptación pendiente:

1. Fijar criterios medibles antes de elegir: exactitud de importe/moneda/fecha, evidencia válida, abstención ante ambigüedad, resistencia a instrucciones en el documento, costo y latencia.
2. Comparar candidatos OpenRouter con un corpus sintético o anonimizado de facturas, PDFs, correos sin obligación, formatos regionales y casos adversarios. Registrar modelo, endpoint, fecha, configuración, tamaño del corpus y métricas.
3. Elegir y registrar una ruta aprobada que cumpla esos criterios y privacidad; revisar selección cuando cambien modelo, prompt, schema o endpoint.
4. Probar límites y fallos de salida antes de habilitar avisos automáticos. Las pruebas fake actuales siguen siendo regresiones útiles, pero no sustituyen esa evaluación.

No se propone un modelo concreto como «el mejor» sin esa evidencia. Tampoco se consultó el catálogo autenticado del operador ni se hicieron generaciones remotas de pago.

## 3. Permisos de lectura

Gmail es la única fuente del usuario implementada. El scope explícito está definido en `packages/gmail/src/index.ts:3` y corresponde a lectura según [Google](https://developers.google.com/workspace/gmail/api/auth/scopes). El conector lee perfil, mensajes, histórico y adjuntos; no implementa envío, borrado ni modificación del buzón. El `POST users.watch` configura notificaciones y está autorizado con `gmail.readonly`, como indica su [referencia](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch).

La brecha está en las credenciales efectivas:

- `apps/api/src/gmail.ts:93`: `include_granted_scopes:"true"` permite combinar permisos otorgados anteriormente al mismo usuario/aplicación. Google describe este comportamiento en [OAuth para aplicaciones web](https://developers.google.com/identity/protocols/oauth2/web-server#incrementalAuth). No demuestra que una cuenta concreta tenga permisos previos de escritura; sí impide garantizar que nunca se incorporen.
- `apps/api/src/gmail.ts:129`: `exchangeCode` valida presencia de tokens, pero no `payload.scope`. En `:368` almacena la credencial y en `:381` activa la conexión.
- `packages/gmail/src/index.ts:343`: `refreshGoogleAccessToken` acepta un access token sin comprobar sus permisos; el runner lo usa para sincronizar.

La prueba adicional de auditoría usó `buildApp`, PostgreSQL temporal y `globalThis.fetch` simulado. Al devolver `gmail.readonly` más `gmail.modify`, el callback respondió **303** y dejó una conexión **active**. Con `scope` omitido ocurrió lo mismo. La renovación también aceptó ambos casos. No se llamó a Google ni se modificó un buzón real.

Los tests OAuth existentes validan sesión, state y replay. Su fixture de intercambio omite `scope` (`apps/api/test/gmail.integration.test.ts:154`) y el caso de conexión exitosa pasa; por tanto, esa suite no comprueba la restricción de permisos.

Aceptación pendiente:

1. Desactivar la inclusión de permisos previos y mantener una lista cerrada de scopes permitidos.
2. Comprobar los permisos efectivos al intercambiar y renovar tokens, antes de guardar/usar credenciales o activar la conexión. Si la respuesta no aporta información suficiente, verificar con Google o bloquear hasta poder acreditarlos; no asumir lectura.
3. Rechazar permisos adicionales/desconocidos y falta de lectura; registrar únicamente un motivo seguro y requerir reconexión. No imprimir tokens ni respuestas del proveedor.
4. Añadir regresiones para readonly, readonly+modify, send, acceso completo al correo, otro servicio y scope ausente; comprobar ausencia de credenciales almacenadas y llamadas de sincronización en los rechazos.
5. Revisar/revocar grants antiguos y reconectar con permisos mínimos. Una modificación de código no reduce retroactivamente una credencial ya concedida.

Telegram es el canal de salida definido por el MVP: usa el bot para vinculación y envío, no un OAuth de acceso a la cuenta personal ni lectura general de su historial. El requisito de lectura se evalúa aquí sobre las fuentes del usuario. Si se extiende literalmente a toda operación externa, el envío de notificaciones por Telegram requiere una excepción explícita en el requisito.

## Verificaciones ejecutadas

Entorno: Node `24.14.1`, pnpm `11.25.0`, dependencias del lockfile sin actualización. PostgreSQL `17.6-alpine` temporal, contenedor `crashmemory-a01-postgres`, puerto `127.0.0.1:54347`, base `crashmemory_a01`, sin volúmenes persistentes. Solo datos sintéticos; no se cargó `.env` ni se accedió a credenciales de usuario.

```bash
pnpm install --frozen-lockfile
pnpm --filter @crashmemory/model-gateway --filter @crashmemory/gmail \
  --filter @crashmemory/extraction --filter @crashmemory/security test
# Contra una base PostgreSQL temporal ya preparada, con URL fuera de Git:
TEST_DATABASE_URL="$A01_TEST_DATABASE_URL" \
  pnpm --filter @crashmemory/api --filter @crashmemory/gmail test
```

Resultados: ModelGateway 6/6, extracción 7/7, seguridad 6/6; Gmail primero 8/8 unitarios y una integración omitida sin DB, después 9/9 con DB; API 6/6 con DB. Son **34 casos distintos aprobados**, sin omisiones en su ejecución con los requisitos disponibles. Aprobar esas pruebas no acredita los controles que todavía no cubren.

Sondas adicionales: proveedor OpenRouter ignorado por el loader; scopes de escritura y ausentes aceptados en callback y refresh. Todos los transportes Google/modelo se simularon; las únicas conexiones de prueba de aplicación fueron al PostgreSQL aislado. No hay evidencia de controles de cuenta, grants reales ni desempeño LLM real. Las fuentes oficiales se consultaron el 2026-10-03; sus políticas deben revalidarse al implementar.

Entrega de auditoría: informe, README y acta A01. La aplicación conserva su implementación actual; las correcciones anteriores quedan pendientes de implementación y posterior auditoría. El informe está preparado para I00 sin declarar integración ni cumplimiento de los requisitos.
