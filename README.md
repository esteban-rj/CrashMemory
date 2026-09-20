# CrashMemory — Cerebro Personal

Plataforma privada para convertir correos, documentos y mensajes autorizados en obligaciones, citas, contratos y gastos con evidencia verificable.

**Estado actual: planificación.** El repositorio contiene la especificación, su revisión y el plan de desarrollo. Todavía no contiene una aplicación ejecutable, servicios Docker ni comandos de instalación del producto.

## Documentación

| Documento | Uso |
| --- | --- |
| [Especificación v1.0](docs/specs/cerebro-personal-v1.0.md) | Referencia original del producto y sus requisitos. |
| [Revisión técnica](docs/planning/revision-spec.md) | Vacíos, riesgos y ajustes propuestos antes de implementar. |
| [Plan multisesión](docs/planning/plan-multisesion.md) | Sesiones, agentes, dependencias, ramas, entregables e integración. |
| [Plantilla de sesión](docs/planning/plantilla-sesion.md) | Instrucciones y acta de entrega para cada sesión. |
| [Reglas para agentes](AGENTS.md) | Restricciones persistentes de modelos, concurrencia, worktrees e integración. |

## Cómo usar este repositorio ahora

1. Leer la revisión y las decisiones que debe cerrar S01.
2. Consultar la tabla de sesiones y comenzar por S01, después S02.
3. Para cada sesión, completar la plantilla con el commit base de `main`, el agente, los archivos propios y los criterios de aceptación.
4. Ejecutar cada sesión en un worktree y una rama exclusivos. Contar coordinadores, revisores y sesiones hijas dentro del límite global de **cuatro sesiones activas**.
5. Al terminar cada sesión, validar e integrar inmediatamente su entrega con la actualización correspondiente de este README.

La política de integración y los comandos de referencia están en el [plan multisesión](docs/planning/plan-multisesion.md). Las sesiones de desarrollo siguen planificadas; la elaboración de estos documentos no las ha iniciado.

## Hitos previstos

| Hito | Resultado | Estado |
| --- | --- | --- |
| S00 | Especificación archivada, revisión y plan multisesión | Completada; [acta](docs/sessions/S00.md) |
| M0 | Monorepo y entorno local reproducible | Pendiente |
| M1 | Gmail → obligación con evidencia → reconciliación → Telegram, web, chat estructurado y costos | Pendiente |
| M2 | Calendar, archivos, contratos, gastos, recurrencias, búsqueda semántica, grafo, bot conversacional y MCP de lectura | Pendiente |
| M3 | WhatsApp oficial, condicionado a permisos y canal de despliegue | Opcional, posterior al MVP |

## Instrucciones de uso después de cada integración

Cada entrega a `main` debe actualizar este archivo con información comprobada:

- Funcionalidad disponible y pasos concretos para utilizarla.
- Requisitos, configuración y nombres de variables necesarias, sin valores secretos.
- Comandos que existan en ese commit, rutas de acceso y resultado esperado.
- Migraciones, reinicios o cambios de compatibilidad requeridos al actualizar.
- Limitaciones actuales y solución de errores habituales.
- Estado del hito y enlace al acta de la sesión integrada.

Las entregas internas deben explicar cómo verificarlas o administrarlas. Una entrega de documentación debe explicar cómo usar el documento nuevo. S02 añadirá a CI una comprobación que exija cambios en el README; la revisión de integración verificará que las instrucciones sean útiles y correctas.

## Principios del desarrollo

PostgreSQL será la fuente de verdad. Todo conocimiento inferido deberá tener evidencia. La IA se accederá mediante un gateway sustituible. El procesamiento será incremental e idempotente, con privacidad y aislamiento por usuario.

Los datos personales, correos reales, documentos del usuario, tokens y secretos permanecerán fuera de Git. Las pruebas versionadas utilizarán datos sintéticos o anonimizados.
