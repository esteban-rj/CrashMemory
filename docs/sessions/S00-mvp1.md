# S00 — Ajuste de alcance a MVP 1

Fecha: 2026-09-20. Continuación documental de la planificación; no inicia sesiones de desarrollo.

- Solicitud: limitar la primera versión a Gmail y notificaciones Telegram, recalcular sesiones y pushear cada commit.
- Base: `7d64199` en main, publicada en origin/main antes de esta actualización.
- Rama: `codex/s00-mvp-gmail`.
- Worktree: `/private/tmp/crashmemory-s00-mvp-gmail`.
- Sesiones activas en esta actualización: una.

## Resultado

Plan v1.1 con diez sesiones de entrega V01–V10 y una coordinadora I00: once sesiones pendientes. Asignación: seis Terra, una Luna y tres Sol para entregas; Terra para coordinación. Máximo cuatro activas en todo el árbol.

Gmail es la única fuente y Telegram el canal de avisos. Se incluye una web mínima para gestión y evidencia, extracción del cuerpo y PDF con texto, seguridad, registro de costos y operación. Las funciones ampliadas se difieren expresamente y se sustituyen los criterios de cierre de M1 del plan anterior.

README, AGENTS y plantilla establecen push inmediato tras todo commit y push de main tras cada integración. Un push pendiente impide declarar la entrega publicada; las protecciones remotas se respetan.

## Validación y cierre

Comprobar enlaces, conteo de sesiones/modelos, slugs únicos, dependencias anteriores a cada ola, máximo cuatro activas y AC-01…AC-12. La especificación original se conserva intacta. La validación es documental; aún no existe aplicación para ejecutar tests.

Publicar el commit en la rama de sesión antes de integrarlo por fast-forward y pushear main. Verificar que los SHA de la rama remota y origin/main coincidan con la entrega. No se registra el propio SHA dentro del commit para evitar una actualización recursiva; consultar el historial por el mensaje de esta entrega.

## Próximo paso

Al comenzar la implementación, iniciar I00 y V01 desde el main remoto que contiene el plan v1.1. La agenda anterior S01–S26 queda sustituida.
