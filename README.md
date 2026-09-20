# CrashMemory — Cerebro Personal

Primera versión: conectar Gmail, detectar obligaciones con evidencia y recibir recordatorios por Telegram. Una web mínima permitirá revisar obligaciones, corregirlas y marcarlas como pagadas.

**Estado actual: planificación.** El repositorio contiene la especificación, su revisión y el plan de desarrollo. Todavía no contiene una aplicación ejecutable, servicios Docker ni comandos de instalación del producto.

## Documentación

| Documento | Uso |
| --- | --- |
| [Especificación v1.0](docs/specs/cerebro-personal-v1.0.md) | Referencia original del producto y sus requisitos. |
| [Revisión técnica](docs/planning/revision-spec.md) | Vacíos, riesgos y ajustes propuestos antes de implementar. |
| [Plan multisesión](docs/planning/plan-multisesion.md) | Sesiones, agentes, dependencias, ramas, entregables e integración. |
| [Plantilla de sesión](docs/planning/plantilla-sesion.md) | Instrucciones y acta de entrega para cada sesión. |
| [Reglas para agentes](AGENTS.md) | Restricciones persistentes de modelos, concurrencia, worktrees e integración. |

## Alcance y sesiones del MVP 1

**10 sesiones de implementación y validación + 1 sesión coordinadora = 11 sesiones pendientes.** Máximo cuatro activas simultáneamente, incluyendo coordinación e hijas.

El alcance incluye cuerpo de correos y PDF adjuntos con texto, sincronización incremental, reconciliación, evidencia, avisos Telegram y gestión web mínima. Conserva autenticación, privacidad, registro/límites de costos y recuperación de datos. Los escaneos que requieran OCR quedan para revisión manual.

Chat, Calendar, contratos, gastos, recurrencias, importaciones generales, búsqueda semántica, grafo, MCP y WhatsApp se difieren. El plan vigente usa V01–V10; sustituye la agenda anterior S01–S26.

## Cómo usar este repositorio ahora

1. Leer la revisión y las decisiones del alcance reducido que debe cerrar V01.
2. Consultar la tabla de sesiones y comenzar con I00 y V01; después V02 y V03.
3. Para cada sesión, completar la plantilla con el commit base de `origin/main`, el agente, los archivos propios y los criterios de aceptación.
4. Ejecutar cada sesión en un worktree y una rama exclusivos. Contar coordinadores, revisores y sesiones hijas dentro del límite global de **cuatro sesiones activas**.
5. Hacer push inmediatamente después de cada commit, incluidos los commits intermedios y de integración.
6. Al terminar cada sesión, validar e integrar su entrega con la actualización correspondiente de este README, pushear `main` y verificar el SHA remoto.

La política de integración y los comandos de referencia están en el [plan multisesión](docs/planning/plan-multisesion.md). Las sesiones de desarrollo siguen planificadas; la elaboración de estos documentos no las ha iniciado.

## Hitos previstos

| Hito | Resultado | Estado |
| --- | --- | --- |
| S00 | Especificación archivada, revisión y plan multisesión | Completada; [acta](docs/sessions/S00.md) |
| Plan v1.1 | Alcance Gmail/Telegram y push tras cada commit | [Acta de actualización](docs/sessions/S00-mvp1.md) |
| Base | Contratos, monorepo, memoria segura y jobs durables (V01–V03) | Pendiente |
| MVP 1 | Gmail → obligación con evidencia → reconciliación → notificación Telegram, web mínima y operación (V04–V10) | Pendiente |
| Versiones posteriores | Funcionalidades ampliadas del spec | Diferidas, fuera del primer MVP |

## Instrucciones de uso después de cada integración

Cada entrega a `main` debe actualizar este archivo con información comprobada:

- Funcionalidad disponible y pasos concretos para utilizarla.
- Requisitos, configuración y nombres de variables necesarias, sin valores secretos.
- Comandos que existan en ese commit, rutas de acceso y resultado esperado.
- Migraciones, reinicios o cambios de compatibilidad requeridos al actualizar.
- Limitaciones actuales y solución de errores habituales.
- Estado del hito y enlace al acta de la sesión integrada.

Las entregas internas deben explicar cómo verificarlas o administrarlas. Una entrega de documentación debe explicar cómo usar el documento nuevo. V01 añadirá a CI una comprobación que exija cambios en el README; la revisión de integración verificará que las instrucciones sean útiles y correctas.

## Commit y push

Todo commit se publica inmediatamente en su rama remota. Cada integración termina además con push de `main`. Si falla un push, se resuelve antes de continuar nuevos entregables o integraciones dependientes; nunca se fuerza el historial. Los comandos y el tratamiento de ramas protegidas están en el [protocolo del plan](docs/planning/plan-multisesion.md).

## Principios del desarrollo

PostgreSQL será la fuente de verdad. Todo conocimiento inferido deberá tener evidencia. La IA se accederá mediante un gateway sustituible. El procesamiento será incremental e idempotente, con privacidad y aislamiento por usuario.

Los datos personales, correos reales, documentos del usuario, tokens y secretos permanecerán fuera de Git. Las pruebas versionadas utilizarán datos sintéticos o anonimizados.
