# Plan de implementación multisesión — MVP 1

Versión 1.1 · 2026-09-20 · Proyecto CrashMemory / Cerebro Personal.

**Alcance vigente: Gmail como única fuente y Telegram como canal de notificaciones. Se prevén 10 sesiones de implementación y validación (V01–V10), más una sesión coordinadora I00: 11 en total.** La planificación S00 ya realizada no forma parte de las sesiones pendientes. Son unidades de entrega que pueden requerir varios turnos, no una estimación de días ni una garantía de duración.

Este plan sustituye al plan de 25 sesiones del commit `7d64199` por instrucción del usuario. Conserva el [spec original](../specs/cerebro-personal-v1.0.md) y su [revisión técnica](revision-spec.md) como referencias. Las sesiones antiguas S01–S26 dejan de ser la agenda de ejecución; se usan identificadores V01–V10 para evitar confusiones.

## 1. Alcance de la primera versión

Flujo de producto:

```text
Conectar Gmail → sincronizar → extraer obligación + evidencia
              → reconciliar cambios → programar aviso → Telegram
```

Incluye OAuth Gmail, histórico acotado, sincronización incremental y recuperación, lectura del cuerpo del correo y PDF adjuntos con texto, obligaciones con importe/moneda/fecha, evidencia verificable, deduplicación, cambios de vencimiento y correcciones. Los mensajes o adjuntos que no puedan interpretarse quedan pendientes de revisión; no generan una obligación confirmada sin soporte.

Telegram permite vincular la cuenta y entregar recordatorios. Los mensajes de vinculación son técnicos; la primera versión no implementa chat conversacional ni ingestión general de mensajes del bot.

Se conserva una **web mínima**: login, conectar/desconectar Gmail, estado de sincronización, lista/detalle de obligaciones y evidencia, confirmar/corregir/descartar/marcar pagada, vincular Telegram y consultar avisos. No requiere un dashboard avanzado.

La base incluye PostgreSQL, jobs durables, almacenamiento de originales, ModelGateway para extracción estructurada, límites y registro de costos, privacidad, autorización, logs sin datos personales, borrado, exportación básica y backup/restore local. La configuración avanzada y el resumen de costos se ofrecen por configuración/API/comandos documentados; el panel visual de costos queda diferido.

Quedan para versiones posteriores: chat, Google Calendar, citas médicas/eventos, contratos como entidad de negocio, contabilidad de gastos, detección de recurrencias, carga manual de archivos, importaciones de historiales, OCR de escaneos, embeddings, búsqueda semántica, grafo, MCP, WhatsApp y despliegue cloud con Terraform/OIDC. Un PDF de factura recibido por Gmail sí pertenece al alcance; un procesador general de contratos no.

El MVP 1 sustituye el cierre amplio de M1 de §102 del spec: sus pasos de chat y dashboard de costos no bloquean esta entrega. Se mantienen los principios de evidencia, privacidad, portabilidad y fiabilidad.

## 2. Agentes y conteo

La selección mantiene la guía documentada en la revisión inicial: Luna para tareas claras sobre contratos estables, Terra para implementación habitual y Sol para seguridad y concurrencia. [OpenAI Docs: modelos y esfuerzo](https://learn.chatgpt.com/docs/models#choosing-sol-terra-and-luna).

| Código | Modelo exacto | Uso en el MVP 1 |
| --- | --- | --- |
| L | `gpt-5.6-luna` | V08, interfaz mínima sobre APIs ya integradas; esfuerzo `medium`. |
| T | `gpt-5.6-terra` | V01, V03, V04, V05, V07 y V09; esfuerzo `high`. I00 usa `medium`. |
| S | `gpt-5.6-sol` | V02, V06 y V10; esfuerzo `high`. |

**Conteo: 6 Terra + 1 Luna + 3 Sol = 10 sesiones de entrega; I00 añade una Terra de coordinación.** No se programa Astra ni esfuerzo `max`/`ultra`. Estos agentes de desarrollo son independientes de los modelos de extracción que el producto configure en ModelGateway.

Si un fallo reproducible requiere más capacidad, documentar intentos y escalar esa sesión, sin crear por defecto otra sesión revisora. Si el alcance obliga a dividir una entrega, actualizar el conteo y las dependencias; no anunciar que siguen siendo diez mientras se crean sesiones adicionales.

## 3. Reglas de trabajo

1. Máximo **cuatro sesiones activas en todo el árbol**, incluyendo I00, revisores y descendientes. Configuración normal: I00 + hasta tres implementadoras. Una sesión en espera debe reservar cupo antes de reanudarse.
2. Un worktree y una rama exclusivos por sesión, incluido I00. Bases de prueba, puertos, volúmenes y configuración local aislados.
3. Empezar desde `main` sincronizado con `origin/main`, con todas las dependencias integradas y verificadas. El árbol expresa responsabilidad; no obliga a apilar ramas sobre trabajo sin integrar.
4. Al finalizar una sesión, validar e integrar su entrega inmediatamente y en forma serial. No esperar al resto de la ola ni al final del MVP.
5. **Todo commit se pushea inmediatamente a su rama remota**, incluidos checkpoints, fixes, merges y reverts. No esperar a finalizar la sesión. La publicación de un checkpoint no autoriza integrarlo si está incompleto.
6. **Cada integración a main incluye README actualizado y push de main.** README documenta funcionalidad, configuración, pasos de uso/verificación y límites que existan en ese commit.
7. Si falla el push, resolver el rechazo o informar el bloqueo; no acumular trabajo nuevo ni marcar la entrega publicada/integrada mientras siga pendiente. Nunca usar force-push ni eludir protecciones.
8. El cambio de plan no inicia el desarrollo. I00 y V01–V10 quedan planificados.

## 4. Sesiones, dependencias y entregables

`Requiere` significa «integrado, pusheado y verificado en origin/main». I00 usa `codex/i00-integration` y `<WT_ROOT>/i00-integration`. Cada fila Vxx usa `codex/<slug>` y `<WT_ROOT>/<slug>`, con una carpeta persistente `WT_ROOT` externa al checkout principal. Registrar las rutas reales en las fichas, especialmente si Codex administra los worktrees.

| ID / slug | Agente / esfuerzo | Requiere | Entrega y áreas propias | Aceptación y actualización del README |
| --- | --- | --- | --- | --- |
| V01 · `v01-foundation` | T / high | Plan v1.1 | Contratos limitados al flujo Gmail/obligaciones/Telegram, ERD y decisiones pendientes; monorepo pnpm/Turborepo, esqueletos Next.js/Fastify/worker/scheduler, Compose PostgreSQL/Redis/MinIO, CI y healthchecks. Archivos raíz, infra local, docs y contratos compartidos. | Clon limpio arranca en modo demo sin credenciales cloud; comandos/puertos/variables documentados. Fijar login, identidad/versionado, dinero/fechas, evidencia, eventos y outbox antes de V02. CI exige cambio en README por entrega; no crear módulos futuros. |
| V02 · `v02-memory-security` | S / high | V01 | Esquemas/migraciones/repositorios de usuario, conexión, credenciales cifradas, SourceItem y revisiones, blobs, evidencia, obligación/versiones/correcciones, cursor, outbox, avisos/intentos y ledger; autenticación y autorización. `db`, `canonical-model`, `security`, rutas auth. | Dos usuarios no acceden a datos/objetos ajenos; dinero exacto, fecha civil/TZ y evidencia inmutable; sesión y callbacks seguros, logs redactados. README con login, migraciones, seed y configuración de secretos. |
| V03 · `v03-durable-runtime` | T / high | V02 | Outbox, BullMQ, consumidores idempotentes, recuperación de jobs desde PostgreSQL, ObjectStorage y observabilidad básica. Worker/scheduler y adaptadores. | Caída entre commit y encolado, reinicios y pérdida de Redis recuperables. README con operación, jobs fallidos, replay, métricas y namespaces por worktree. |
| V04 · `v04-gmail` | T / high | V03 | OAuth de fuente y consentimientos, histórico limitado, MIME/cuerpo/adjuntos PDF, sync incremental, Pub/Sub, renovación watch, recovery de cursor y reconexión. `connectors/gmail`, API de fuentes/webhook. | Bootstrap y catch-up no pierden correos; replay/reordenamiento no duplican; alcance autorizado respetado. Adjuntos quedan como blobs tipados para V05. README de Google OAuth/scopes/PubSub, sync y errores. |
| V05 · `v05-extraction` | T / high | V03 | ModelGateway de texto estructurado con fake y adaptador remoto configurable; privacidad y bloqueo sin ruta válida; presupuesto/ledger; parsers del cuerpo y PDF con texto, candidatos de obligación/evidencia y evals. `model-gateway`, `extraction`, fixtures. | Importe/moneda/fecha verificables; páginas/fragmentos del PDF; JSON inválido, ambigüedad y prompt injection controlados. `local-only` nunca sale a remoto; OCR no disponible se informa. README de perfiles, costo por API/comando, límites y revisión de candidatos. |
| V06 · `v06-reconciliation` | S / high | V05 | Identidad estable, dedupe, versionado, conflictos, correcciones protegidas, API de obligaciones/evidencias y eventos de cambio. `reconciliation`, servicios y rutas propias. | Segundo correo cambia vencimiento con una sola versión actual; dos workers no pisan correcciones; campos confirmados quedan protegidos. README de consulta, confirmación, edición, pago y conflictos. |
| V07 · `v07-telegram-reminders` | T / high | V03 | Vinculación segura del bot, NotificationGateway, políticas/scheduler, registro de intentos, cancelación/reprogramación y proveedor Telegram. `notifications`, handlers y rutas propias. | Con fixtures de eventos acordados, retries no duplican envíos confirmados; resultado ambiguo queda `unknown`; pagada/cancelada/borrada no vuelve a avisar. README de vinculación, horarios, privacidad y resolución de fallos. El flujo con V06 se prueba en V10. |
| V08 · `v08-minimal-web` | L / medium | V04, V06, V07 | Web mínima sobre APIs existentes: login, conexión Gmail, estado de sync, obligaciones/evidencia, corrección/pago, vínculo Telegram y estado de avisos. `apps/web`, sin rediseñar contratos del backend. | Recorrido web real hasta DB, controles de permiso y estados vacíos/error. README con rutas y pasos de uso. Escalar a Terra si surge trabajo de backend no previsto. |
| V09 · `v09-lifecycle` | T / high | V04, V06, V07 | Revocación/desconexión y borrado por fuente/conector/cuenta, exportación básica y backup/restore; endpoints y comandos operativos, sin depender de nueva UI. Servicios de ciclo de vida y scripts. | Borrar cancela jobs/avisos y evita resurrección; exportación y restore de DB/objetos probados; conservar solo conocimiento aún sustentado. README de operación, retención, borrado y recuperación. |
| V10 · `v10-mvp-validation` | S / high | V08, V09 | E2E del flujo completo, fixtures/evals, pruebas de fallos, revisión de permisos y privacidad, walkthrough desde clon limpio y acta de MVP 1. Tests e informe. | Correo real autorizado → obligación con evidencia → actualización reconciliada → aviso Telegram; tests sintéticos y prueba real separados; regresiones y README verificados. Publicar estado real de validación y límites. |

V07 puede desarrollarse junto con Gmail y extracción porque consume contratos y eventos fijados en V01/V02; no necesita esperar al código del reconciliador. Cada API permanece validada con fixtures hasta conectar el flujo real. V08 consume APIs integradas. V09 entrega operación por API/comandos, de modo que puede trabajar en paralelo con la web sin editar sus pantallas.

Las diez sesiones incluyen código, migraciones, pruebas, documentación y sus correcciones. No se reserva una sesión adicional implícita para cada integración o revisión: esas acciones corresponden a I00 o a la dueña del cambio dentro de los mismos cupos.

## 5. Árbol y agenda

```text
I00 · Coordinación e integración
├── V01 → V02 → V03
├── V04 · Gmail
├── V05 · Extracción → V06 · Reconciliación
├── V07 · Avisos Telegram
├── V08 · Web mínima
├── V09 · Ciclo de vida
└── V10 · Validación del MVP 1
```

La tabla de dependencias es autoritativa; el árbol agrupa responsabilidades. Una subdivisión necesita nuevo ID/rama/worktree y consume uno de los mismos cuatro cupos globales. I00 actualiza el conteo si sucede.

| Ola | Cupo 1 | Cupo 2 | Cupo 3 | Cupo 4 | Resultado |
| --- | --- | --- | --- | --- | --- |
| 0 | I00 | V01 | — | — | Contratos y entorno local. |
| 1 | I00 | V02 | — | — | Memoria y seguridad. |
| 2 | I00 | V03 | — | — | Runtime durable. |
| 3 | I00 | V04 | V05 | V07 | Gmail, extracción y avisos. |
| 4 | I00 | V06 | — | — | Reconciliación y API de obligaciones. |
| 5 | I00 | V08 | V09 | — | Uso mínimo y operación. |
| 6 | I00 | V10 | — | — | MVP 1 verificado. |

Las olas muestran una agenda válida, no barreras de integración. Al terminar una sesión, se integra y pushea de inmediato; una dependiente puede comenzar si ya están sus requisitos en origin/main y hay cupo. Máximo observado: I00 + tres implementadoras.

## 6. Worktrees, commit, push e integración

### Inicio y aislamiento

I00 usa la [plantilla](plantilla-sesion.md) para registrar modelo, cupo, commit remoto base, ruta, rama, dependencias y archivos propios. Sincronizar refs y comprobar que el checkout de main está limpio antes de actualizarlo por fast-forward. Ejemplo, solo cuando V04 tenga sus requisitos:

```bash
git fetch origin
git merge --ff-only origin/main
git worktree add -b codex/v04-gmail "$WT_ROOT/v04-gmail" main
```

Cada sesión tiene puertos, `COMPOSE_PROJECT_NAME`, DB y volúmenes de prueba propios. Si Codex devuelve un worktree administrado, registrar su ruta y asignar la rama prevista antes de trabajar. Los fixtures son sintéticos; secretos y datos personales quedan fuera de Git.

### Todo commit lleva push

Validar los cambios relevantes, revisar el diff y seleccionar explícitamente los archivos que se van a versionar. Después de crear **cualquier** commit, hacer push inmediatamente; en una rama nueva configurar upstream:

```bash
# En la rama exclusiva de la sesión; cambios revisados y staged.
git commit -m "feat(gmail): add incremental sync (V04)" && git push -u origin HEAD
```

La misma regla aplica a un commit automático de merge, un checkpoint, fix o revert. Preferir merges preparados con `--no-commit` para validar antes de crear el commit y publicarlo. Evitar comandos que creen commits de manera inadvertida sin su push correspondiente. No acumular commits locales para publicarlos al final.

Si el push falla, guardar el SHA y el error, detener nuevos entregables e integraciones dependientes y resolver conexión, autenticación o rechazo. Ante divergencia, consultar el remoto y reconciliar sin force-push; todo commit nuevo de resolución también debe pushearse. No reportar «publicado» hasta verificar el SHA en la rama remota.

### Entrega e integración por sesión

1. Sincronizar con el main remoto vigente y resolver incompatibilidades propias. Todo commit que produzca esa sincronización se pushea conforme a la regla anterior.
2. Completar comportamiento, pruebas y migraciones; actualizar README y acta `docs/sessions/Vxx.md` con instrucciones comprobadas.
3. Crear y pushear el commit de entrega. Entregar a I00 el SHA exacto, rama remota, checks y límites. Solo entonces marcar `lista_para_integrar`.
4. I00 toma el bloqueo exclusivo de integración, parte del main remoto actualizado e integra el SHA publicado. Validar el resultado combinado, incluyendo README y migraciones.
5. Crear el merge commit y pushearlo inmediatamente a la rama de integración. Avanzar main por fast-forward y pushear main. La entrega solo queda `integrada` al comprobar el SHA en origin/main y los checks requeridos.

```bash
# En el worktree limpio de I00, sobre codex/i00-integration.
git fetch origin
git merge --ff-only origin/main
git merge --no-ff --no-commit "$SESSION_SHA"

# Validar el resultado combinado y README antes del commit.
git commit -m "merge: integrate V04 gmail with usage docs" && git push -u origin HEAD

# En el checkout limpio de main, bajo el mismo bloqueo.
git merge --ff-only codex/i00-integration && git push origin main
```

Antes de avanzar main, comprobar que origin/main no se movió desde la base; un push rechazado obliga a incorporar el avance y repetir checks afectados. No forzar. Si fallan validaciones antes del commit, devolver el fallo a la sesión o abortar el merge preparado, conservando sus commits ya publicados.

Si hay protección remota, el PR y su cola de merge sustituyen el avance directo; esperar checks requeridos y comprobar origin/main después del merge. El push está autorizado por el usuario y es parte de toda entrega; no implica desplegar el producto ni contactar a otras personas.

Las actualizaciones documentales S00, sin integraciones concurrentes, pueden ir por fast-forward desde su rama propia, siempre con commit y push de la rama, actualización de README y push de main. I00 se crea al iniciar la implementación.

### Recursos compartidos

| Recurso | Regla |
| --- | --- |
| README | Cada sesión prepara su delta; I00 combina sin perder instrucciones vigentes y prueba el recorrido afectado. |
| Contratos | Cambios aditivos coordinados con consumidores; no redefinir tipos por feature. |
| Migraciones | Orden reservado, nunca editar aplicadas; reconciliar snapshots/journal contra main bajo exclusión y repetir pruebas. |
| Lockfile y manifests | V01 fija convenciones; regenerar con pnpm al integrar dependencias, sin pegar fragmentos del lockfile. |
| Rutas/jobs | Módulos por feature; serializar cambios al registro común. |
| Datos de pruebas | Namespace por worktree; ningún migrador concurrente sobre una DB mutable compartida. |

## 7. Definition of Done y aceptación

Cada entrega demuestra su objetivo, permisos, validación, evidencia y manejo de fallos; pasa checks sobre su rama y el resultado combinado; incluye migraciones cuando correspondan, README comprobado y configuración de ejemplo sin secretos. V01 define los comandos de lint, formato, tipos, tests, build y comprobación de migraciones; CI exige cambio en README respecto de la base de integración, e I00 comprueba la utilidad del contenido.

**Toda entrega debe tener commit de rama publicado y resultado integrado en origin/main.** Un commit local, push fallido o validación externa pendiente no se presenta como completado. Mantener las limitaciones de pruebas reales separadas de la aceptación técnica con fixtures.

| Criterio | Dueño | Prueba para MVP 1 |
| --- | --- | --- |
| AC-01 reconstrucción | V01, V10 | Clon limpio, configuración documentada y arranque local. |
| AC-02 persistencia | V01, V03, V09 | Recrear containers y restaurar DB/objetos/trabajo pendiente. |
| AC-03 incremental | V04 | Solo novedades normalmente; resync controlado si el cursor es inválido. |
| AC-04 idempotencia | V03, V05, V06 | Replays y concurrencia no duplican obligación actual. |
| AC-05 evidencia | V02, V05, V08 | Fragmento/revisión/página de origen accesible solo por su dueño. |
| AC-06 actualización | V06, V07 | Fecha cambia con histórico y cancelación/reprogramación de avisos. |
| AC-07 privacidad | V05 | Cero salida remota para local-only, incluyendo reintentos/fallback; sin backend permitido, bloquear. |
| AC-08 portabilidad IA | V05 | Adaptadores fake y real intercambiables por perfil sin modificar dominio. |
| AC-09 secretos | V01, V02 | Scan de repo/artefactos y redacción de logs; nunca tokens o correos reales en Git. |
| AC-10 avisos | V07, V10 | Intentos confirmados deduplicados; timeout ambiguo queda unknown sin reenvío ciego. |
| AC-11 corrección | V06 | Inferencia posterior no sobrescribe campos fijados; conflicto visible. |
| AC-12 borrado | V09, V10 | Se invalidan soportes y cancelan jobs/avisos; no reaparece información al restaurar/reprocesar. |

V10 cierra: login → conectar Gmail → sincronizar intervalo → detectar obligación → consultar evidencia → recibir cambio de vencimiento → reconciliar → enviar recordatorio por Telegram → marcar pagada → cancelar futuros avisos. Añade borrado, restore y control de presupuesto. El flujo real requiere autorización y credenciales válidas; si faltan, indicar «demo validada / validación real pendiente».

Los umbrales de recordatorios automáticos se habilitan con calidad medida y política explícita. Antes de eso, una obligación puede confirmarse manualmente. Las pruebas incluyen cuerpo de correo, PDF con texto, fechas ambiguas, adjunto escaneado no procesable, cambios, duplicados, fallo de proveedor y resultado de envío desconocido.

## 8. Correspondencia con el plan anterior

| Plan v1.0 | Plan v1.1 |
| --- | --- |
| S01 + S02 | V01, limitadas a contratos y base de este flujo. |
| S03 + S04 | V02, sin modelos de citas, contratos, gastos o conversaciones. |
| S05 | V03. |
| S07 | V04. |
| S06 + S08 + registro de costos de S12 | V05, sin embeddings, visión ni panel de costos. |
| S09 | V06. |
| S11 | V07. |
| S10 | V08, interfaz mínima sin dashboard/calendario. |
| S14 | V09, ciclo de vida del alcance reducido. |
| S15 | V10, aceptación específica del MVP 1. |
| S13, resto de S12 y S16–S26 | Diferidos; no se crean sesiones para ellos al iniciar MVP 1. |

PB-001…004, PB-006…008 y PB-033 se cubren en V01; PB-005/PB-031 en V03; PB-009…013/PB-024 y esquema PB-032 en V02; PB-014…017 en V04; PB-018…021/PB-023 en V05; PB-022 en V06; PB-025…027 en V07; PB-028…030 entre V06/V08. Auditoría PB-032 se emite en las operaciones sensibles de cada sesión. PB-034 tiene controles básicos desde V01/V02; PB-035 queda limitado a imágenes locales. La automatización de registro cloud y PB-036/OIDC se difieren.

## 9. Primer arranque

Al iniciar la ejecución, crear I00 y V01 con sus worktrees/modelos; son dos cupos. V01 integra y pushea contratos y base; luego V02 y V03. La primera ola de tres implementadoras es V04 + V05 + V07. Cada commit va al remoto inmediatamente y cada sesión termina con integración, README y push de main.

Se necesitarán identidad/login definido en V01, consentimiento Gmail, configuración Pub/Sub, bot Telegram y proveedor/política de modelos. Las credenciales se provisionan fuera de Git. No se necesita configurar Calendar, WhatsApp ni un cloud de despliegue para iniciar este MVP.
