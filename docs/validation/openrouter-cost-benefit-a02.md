# A02 — OpenRouter: privacidad, selección y costo/beneficio

Investigación: **2026-10-03**. Base auditada: `2527d3e5dfa32e14ebc2102c2415321b3ea49468`. Alcance autorizado: corregir el requisito 1 de A01 y habilitar modelos OpenRouter de distintos fabricantes, elegidos por costo/capacidad. El hallazgo de scopes Gmail no forma parte de A02.

## Por qué OpenRouter no se usaba

El spec lo permitía como opción futura sin equipararlo automáticamente con privacidad. [ADR 0002](../adr/0002-remote-model-privacy.md), introducido en `0a63ba0`, eligió OpenAI directo; V05 (`287617c` y cierre `7ad8cea`) implementó esa decisión. El loader devolvía siempre `provider: "openai"`, el adaptador sólo llamaba a OpenAI Responses y la validación admitía únicamente `gpt-5.6-terra` con esfuerzo `medium`. No existía una ruta OpenRouter que habilitar por variable.

A02 añade el transporte Chat Completions de OpenRouter, conecta el worker al selector de proveedor y reemplaza la plantilla inicial. Las instalaciones sin `MODEL_PROVIDER` mantienen OpenAI hasta seleccionar el nuevo proveedor explícitamente. Claves y confirmaciones son independientes.

## Investigación y selección

Se consultaron sin autenticación [el catálogo](https://openrouter.ai/api/v1/models), los endpoints de cada modelo y [la lista pública ZDR](https://openrouter.ai/api/v1/endpoints/zdr). Se cruzaron estado disponible, soporte `response_format`/`structured_outputs`, precios y slug de endpoint. No se usaron rankings como prueba de precisión ni contenido de usuarios.

La única tarea LLM es extraer obligaciones con campos y offsets verificables. Se divide por entrada: cuerpo corto (`obligation-body`) y texto PDF/cuerpo largo (`obligation-document`). Gmail, parseo PDF, evidencia, reconciliación y Telegram son deterministas; no necesitan modelos ni embeddings.

| Modelo evaluado                                        |           Entrada/salida USD por millón |        Contexto publicado | JSON estructurado | Ruta revisada                 | Decisión                                                          |
| ------------------------------------------------------ | --------------------------------------: | ------------------------: | ----------------- | ----------------------------- | ----------------------------------------------------------------- |
| Mistral Small 4 — `mistralai/mistral-small-2603`       |                             0,15 / 0,60 |                   262.144 | Sí                | `mistral/zdr`                 | Predeterminado: cuerpo hasta 4.000 unidades UTF-16, sin texto PDF |
| Gemini 3.1 Flash Lite — `google/gemini-3.1-flash-lite` |                             0,25 / 1,50 |                 1.048.576 | Sí                | `google-vertex/global`        | Predeterminado: texto PDF o cuerpo mayor                          |
| Gemini 2.5 Flash — `google/gemini-2.5-flash`           |                             0,30 / 2,50 |                 1.048.576 | Sí                | `google-vertex/global`        | Alternativa explícita; cuesta más que Flash Lite                  |
| Claude Haiku 4.5 — `anthropic/claude-haiku-4.5`        |                             1,00 / 5,00 |                   200.000 | Sí                | `amazon-bedrock/global`       | Alternativa premium; evaluar mejora antes de justificar gasto     |
| GPT-5.4 Nano — `openai/gpt-5.4-nano`                   |                             0,20 / 1,25 |                   400.000 | Sí                | Azure ZDR disponible          | Comparador; no añadido al catálogo A02                            |
| GPT-5.6 Terra — OpenAI anterior                        | 2,00 / 12,00 base; reserva 2,50 / 12,00 | No necesario para decidir | Sí                | OpenAI directo, `store:false` | Compatibilidad; no predeterminado de la plantilla                 |

Precios de endpoints estándar: [Mistral](https://openrouter.ai/api/v1/models/mistralai/mistral-small-2603/endpoints), [Flash Lite](https://openrouter.ai/api/v1/models/google/gemini-3.1-flash-lite/endpoints), [Flash 2.5](https://openrouter.ai/api/v1/models/google/gemini-2.5-flash/endpoints), [Haiku](https://openrouter.ai/api/v1/models/anthropic/claude-haiku-4.5/endpoints), [Nano](https://openrouter.ai/api/v1/models/openai/gpt-5.4-nano/endpoints); [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra). Flex, prioridad y regiones pueden tener tarifas distintas.

Mistral documenta Small 4 como multilingüe y compatible con extracción estructurada y documentos: [ficha oficial](https://docs.mistral.ai/models/mistral-small-4-0-26-03). Su costo y modo instruct sin razonamiento justifican una primera opción para cuerpos sencillos. Google describe Flash Lite para extracción de datos a gran volumen y admite salida estructurada: [ficha oficial](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite). Su esfuerzo mínimo y soporte documental justifican otra ruta económica para documentos. Es una inferencia de capacidad, no una comparación de precisión medida.

Gemini no activa OCR: el MVP sólo envía texto obtenido localmente del PDF. Las ventanas publicadas no aumentan la cota local de entrada: 16.000 bytes de la solicitud completa por defecto, usados como límite conservador de tokens. `MODEL_MAX_INPUT_TOKENS` admite hasta 64.000; salida hasta 4.000 tokens y timeout hasta 120 segundos.

También se revisaron variantes Google Flash más recientes del catálogo. Sus tarifas mayores no prueban beneficio para esta extracción acotada. Se excluyen modelos gratuitos, auto/free, previews y endpoints sin ZDR. Mistral normal y Google AI Studio no cumplían la combinación ZDR elegida; no son fallbacks. Anthropic admite [salida estructurada en Haiku](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), pero su costo requiere evidencia propia para usarlo por defecto.

### Ejemplo comparable de gasto

Supuesto: 4.000 tokens de entrada y 600 de salida por extracción; instrucciones/schema incluidos en entrada. Sin caché, reintentos, impuestos ni cargos de compra de créditos. Fórmula: `(entrada × tarifa entrada + salida × tarifa salida) / 1.000.000`.

| Modelo                 | USD por extracción | USD por 1.000 extracciones |
| ---------------------- | -----------------: | -------------------------: |
| Mistral Small 4        |           0,000960 |                       0,96 |
| Gemini 3.1 Flash Lite  |           0,001900 |                       1,90 |
| GPT-5.4 Nano           |           0,001550 |                       1,55 |
| Gemini 2.5 Flash       |           0,002700 |                       2,70 |
| Claude Haiku 4.5, base |           0,007000 |                       7,00 |
| GPT-5.6 Terra, base    |           0,015200 |                      15,20 |

Ahorro teórico frente a Terra base: 93,7% con Mistral y 87,5% con Flash Lite, con igual consumo de tokens. El consumo real puede diferir; no es una factura ni una proyección de precisión. La reserva conservadora de Terra sería US$17,20 por mil; la de Haiku usa US$2/M de entrada, techo publicado de escritura de caché de una hora, y sería US$11,00 por mil. El ledger liquida estimaciones decimales, no costos reales auditados del proveedor.

## Corrección del requisito 1

Toda solicitud exige `data_collection: "deny"`, `zdr: true`, endpoint exacto, `allow_fallbacks: false`, `require_parameters: true` y techo de precios. JSON Schema estricto se valida también localmente. Se rechazan redirects, modelo sustituido, truncamiento, refusals y JSON inválido. No se activan herramientas/plugins ni se transmiten identificadores de usuario de CrashMemory. Contrato: [selección de proveedores](https://openrouter.ai/docs/guides/routing/provider-selection), [salida estructurada](https://openrouter.ai/docs/guides/features/structured-outputs), [Chat Completions](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion).

La cuenta exige `MODEL_OPENROUTER_DATA_CONTROLS_CONFIRMED=true`, además de habilitación remota, perfil autorizado y presupuesto. Debe verificarse fuera de Git que **OpenRouter Use of Inputs/Outputs** y **Private Input & Output Logging** estén desactivados en el workspace de la clave. La variable registra confirmación y no consulta esos ajustes. Son controles separados y los metadatos de uso permanecen: [política de datos](https://openrouter.ai/docs/guides/privacy/data-collection). El filtro del proveedor no sustituye los ajustes propios de OpenRouter.

ZDR cubre endpoints de inferencia bajo [sus condiciones oficiales](https://openrouter.ai/docs/guides/features/zdr), incluidas posibles cachés implícitas en memoria. Entrenamiento y retención son requisitos distintos. El [razonamiento facturable](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) se configura como `none` en Mistral, `minimal` en Flash Lite y deshabilitado en las alternativas.

## Verificación y operación

Los comandos del README verifican transporte, privacidad, tarea, schema, presupuesto y flujo durable con fixtures. Las regresiones bloquean claves/confirmaciones cruzadas, auto/free/modelos desconocidos, ausencia de presupuesto, exceso de entrada, timeout y errores HTTP sin cambiar de ruta. No contienen datos personales ni claves reales. Resultados y SHA: [acta A02](../sessions/A02.md).

No se realizó inferencia facturable ni se configuró una cuenta real en esta sesión. Para acreditar cumplimiento operativo falta comprobar los ajustes de la cuenta de `OPENROUTER_API_KEY` y ejecutar una extracción sintética con esa clave, perfil y presupuesto.

Antes de avisos automáticos, evaluar calidad con un corpus autorizado y etiquetado: facturas colombianas/españolas, cuerpos/PDF, varias obligaciones, montos localizados, moneda/fecha ausentes, ambigüedad, OCR no soportado e instrucciones maliciosas. Comparar rutas con el mismo schema/validadores y medir obligación correcta, monto/moneda/fecha exactos, citas/offsets correctos, revisión manual, latencia p50/p95, tokens y costo por obligación correcta. A02 no inventa umbrales ni atribuye esas métricas a tests fake.

## Configuración efectiva

Pasos 5 y 8 del [README](../../README.md). `MODEL_BODY_MODEL`/`MODEL_DOCUMENT_MODEL` admiten los cuatro modelos revisados. Ante cambios de precio o disponibilidad se actualiza el catálogo sin relajar privacidad ni aceptar fallbacks arbitrarios. Deshabilitar `MODEL_REMOTE_ENABLED` o volver a `local-only` bloquea nuevas salidas; no reprocesa trabajos anteriores ni crea un adaptador local de producción.
