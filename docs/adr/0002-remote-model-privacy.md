# ADR 0002 — Modelo remoto inicial y barrera de privacidad

- Estado: aceptada para implementación en V05.
- Fecha: 2026-09-20.
- Alcance: ModelGateway de extracción del MVP Gmail → obligaciones.

## Decisión

El perfil remoto inicial será configurable y usará OpenAI Responses API con:

- modelo `gpt-5.6-terra`;
- `reasoning.effort: "medium"`;
- `store: false` en cada solicitud;
- ejecución foreground, sin background mode;
- sin fallback remoto para solicitudes `local-only`.

La documentación oficial identifica `gpt-5.6-terra` como un modelo de equilibrio entre capacidad y costo, compatible con Responses API y con esfuerzo `medium` disponible y predeterminado: [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra).

El proveedor remoto permanece deshabilitado hasta que una persona responsable confirme explícitamente la configuración del proyecto API. La confirmación debe constar en configuración operativa fuera de Git e incluir que el proyecto no tiene activado ningún opt-in para compartir datos o entrenamiento. Una API key presente por sí sola no habilita salida remota.

La política de enrutamiento es cerrada:

- `local-only`: nunca usa red, reintento externo ni fallback remoto. Si no hay ruta local válida, bloquea y deja el elemento para revisión.
- `remote-allowed`: sólo usa el proyecto y modelo aprobados cuando la barrera de configuración está confirmada. Sin confirmación, también bloquea.
- Un error del proveedor no autoriza cambiar de modelo, endpoint, proyecto o perfil de privacidad. Cada fallback futuro requiere una decisión y configuración explícitas.

## Entrenamiento, almacenamiento y retención

No usar datos para entrenamiento y no retener datos son garantías distintas. Según los [controles de datos oficiales de OpenAI](https://developers.openai.com/api/docs/guides/your-data), los datos enviados por API no se usan para entrenar o mejorar modelos salvo opt-in explícito. Esa política no equivale a Zero Data Retention.

`store: false` evita solicitar estado de aplicación persistente de la respuesta, pero no elimina por sí solo los logs de monitoreo de abuso. La documentación oficial indica que esos logs pueden contener contenido del cliente y que, por defecto, se conservan hasta 30 días, con excepciones legales o de seguridad. ZDR y Modified Abuse Monitoring requieren aprobación y configuración separadas. CrashMemory no afirmará ZDR mientras no exista evidencia operativa de que el proyecto fue aprobado y configurado para ello.

V05 debe mostrar esta diferencia en configuración y documentación. No debe guardar prompts, respuestas ni tokens de proveedor en logs de aplicación. El ledger registra metadatos de consumo y costo sin copiar el contenido enviado.

## Configuración y aceptación de V05

V05 definirá nombres finales equivalentes a estos controles, sin valores sensibles en Git:

```dotenv
MODEL_PROVIDER=openai
MODEL_NAME=gpt-5.6-terra
MODEL_REASONING_EFFORT=medium
MODEL_REMOTE_ENABLED=false
MODEL_PROJECT_DATA_CONTROLS_CONFIRMED=false
```

La aceptación exige pruebas que demuestren:

1. `local-only` produce cero llamadas de red incluso en retries y fallos.
2. `remote-allowed` bloquea si falta cualquiera de las dos confirmaciones.
3. Cada request aprobado contiene `store: false`, el modelo configurado y esfuerzo `medium`.
4. No existe fallback no declarado.
5. Logs y ledger no contienen cuerpo de correo, texto de PDF, prompt, respuesta ni credencial.

## Consecuencias

El MVP puede funcionar en modo local o quedar pendiente de revisión sin exportar contenido. Habilitar el proveedor remoto es una acción consciente por proyecto. La latencia o indisponibilidad remota no reduce esta barrera de privacidad.
