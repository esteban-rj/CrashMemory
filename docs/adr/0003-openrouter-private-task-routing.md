# ADR 0003 — OpenRouter privado y modelos por tarea

- Estado: aceptada e implementada en A02; sustituye la selección inicial de ADR 0002 para instalaciones nuevas.
- Fecha: 2026-10-03.
- Alcance: extracción del MVP Gmail → obligaciones; sin nuevos conectores ni tareas generativas.

## Problema y decisión

ADR 0002 eligió OpenAI Responses y V05 fijó proveedor, endpoint y combinación modelo/esfuerzo. `MODEL_PROVIDER=openrouter` era ignorado. Faltaban configuración, transporte y política para ese intermediario.

La plantilla nueva selecciona `MODEL_PROVIDER=openrouter`. El worker construye el adaptador correspondiente; OpenAI directo sigue disponible para instalaciones anteriores. Ausencia de `MODEL_PROVIDER` conserva la ruta previa y evita que una actualización exporte una clave OpenAI a otro servicio.

OpenRouter recibe exclusivamente `OPENROUTER_API_KEY`. Sólo se autoriza con `MODEL_REMOTE_ENABLED=true`, `MODEL_OPENROUTER_DATA_CONTROLS_CONFIRMED=true`, perfil `remote-allowed` y una reserva de presupuesto vigente. La confirmación OpenAI no autoriza OpenRouter.

## Barrera obligatoria por solicitud

El adaptador fija HTTPS, rechaza redirects y aplica siempre:

- `provider.data_collection: "deny"` y `provider.zdr: true`;
- `provider.only` con un slug exacto de endpoint revisado;
- `allow_fallbacks: false`, `require_parameters: true` y techo de precio;
- JSON Schema estricto, validación local adicional y límites de entrada/salida/tiempo;
- una solicitud sin reintento HTTP automático, herramientas, plugins ni búsqueda externa.

Si esa combinación no está disponible, bloquea/falla; no reduce las restricciones. El error conserva la reserva como consumo desconocido. `local-only` jamás usa esta ruta, incluso si no hay adaptador local.

Estos campos son parte del código, no preferencias configurables por documentos o variables que permitan desactivarlos. Contrato oficial: [selección de proveedores](https://openrouter.ai/docs/guides/routing/provider-selection), [ZDR](https://openrouter.ai/docs/guides/features/zdr) y [salida estructurada](https://openrouter.ai/docs/guides/features/structured-outputs).

La cuenta OpenRouter debe tener desactivados el uso propio de entradas/salidas y el logging de contenido. La confirmación operativa acredita su revisión; no cambia ni inspecciona esos ajustes. El filtro de proveedores no sustituye ese control de cuenta. Ver [recopilación de datos](https://openrouter.ai/docs/guides/privacy/data-collection). ZDR no elimina metadatos ni excluye necesariamente cachés implícitas en memoria.

## Selección y costo

La [investigación A02](../validation/openrouter-cost-benefit-a02.md) elige dos rutas deterministas:

- `obligation-body`: Mistral Small 4 (`mistralai/mistral-small-2603`, `mistral/zdr`), sin razonamiento, para cuerpos de hasta 4.000 unidades UTF-16 sin texto PDF.
- `obligation-document`: Gemini 3.1 Flash Lite (`google/gemini-3.1-flash-lite`, `google-vertex/global`), esfuerzo mínimo, cuando hay páginas PDF con texto o un cuerpo mayor.

El umbral es una heurística de entrada, no una medición de calidad ni un contador de tokens. El límite conservador de bytes de la solicitud completa sigue aplicándose. El parser PDF permanece local; los escaneos continúan en revisión manual.

`MODEL_BODY_MODEL` y `MODEL_DOCUMENT_MODEL` admiten únicamente modelos del catálogo revisado en `packages/model-gateway/src/openrouter-models.ts`. Se incluyen Gemini 2.5 Flash y Claude Haiku 4.5 como alternativas explícitas; ningún fallo activa esos modelos automáticamente. Añadir un modelo, endpoint o precio requiere revisar el catálogo de nuevo.

La reserva, liquidación estimada y ledger identifican el modelo y versión de tarifas elegidos para la tarea. OpenRouter no acepta overrides de tarifas OpenAI. Para Haiku se reserva conservadoramente el precio más alto publicado de escritura de caché. La sincronización, reconciliación y notificación no generan gasto LLM.

## Validación y límite de la decisión

Las pruebas interceptan el HTTP del adaptador real y verifican privacidad, claves separadas, selección por tarea, presupuesto, esquema, abort, errores y ausencia de fallback. El worker también se valida con PostgreSQL y transporte sintético. Ninguna prueba envía datos privados ni realiza inferencia facturable.

La capacidad y las tarifas justifican la selección inicial. La precisión y la latencia sobre obligaciones reales no se han medido; antes de avisos automáticos deben evaluarse con el corpus autorizado indicado en A02. No se declara cumplimiento operativo al 100% sin evidencia de la cuenta y del despliegue.
