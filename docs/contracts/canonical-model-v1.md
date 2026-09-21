# Contrato canónico v1 — Gmail, obligaciones y Telegram

Versión: `2026-09-20.v1`. Es el único contrato que V02–V07 pueden ampliar de forma aditiva. La primera versión no modela chat, Calendar, contratos, gastos, recurrencias, OCR, WhatsApp ni datos de otras fuentes.

## Identidad y acceso

`User` tiene un UUID inmutable y es dueño de cada conexión, objeto, evidencia, obligación, recordatorio y evento. El login de CrashMemory se separa estrictamente de OAuth de Gmail: V02 implementará cuentas locales con correo normalizado, contraseña hasheada con un algoritmo de contraseña adaptativo y una sesión opaca, revocable, almacenada en el servidor y enviada por cookie `HttpOnly`, `Secure` en HTTPS, `SameSite=Lax` y `Path=/`. Las mutaciones autenticadas exigen protección CSRF. La cookie nunca contiene datos de Gmail, Telegram ni autorización de proveedor.

La conexión Gmail pertenece al usuario y conserva estado de consentimiento y cursor. Las credenciales OAuth son secretos cifrados, fuera de respuestas HTTP y logs. El modo demo no tiene usuario, cookie ni acceso a proveedores; sólo expone datos sintéticos marcados como tales.

## Fuente, original y evidencia

`SourceItem` representa un mensaje Gmail por su identidad externa estable y por usuario. `SourceItemRevision` conserva cada representación recibida, su `contentSha256`, momento observado y vínculo al blob original. Un `Blob` contiene bytes, tipo, tamaño, hash y ubicación; las autorizaciones para leerlo verifican el mismo `userId` que su fuente.

`Evidence` es inmutable y apunta a una revisión concreta, nunca sólo a la obligación actual. Contiene un fragmento verificable: `email_body_fragment` usa offsets de unidades UTF-16 del cuerpo normalizado; `pdf_text_fragment` añade adjunto y página (uno-indexada), con offsets UTF-16 del texto extraído de esa página. Ambos incluyen cita y SHA-256 del contenido del que derivan. Cambiar texto, adjunto o revisión crea evidencia nueva.

## Obligación, versiones y correcciones

`Obligation` tiene un ID lógico estable y pertenece a un usuario. `ObligationVersion` es inmutable, tiene revisión creciente y una sola versión actual por obligación. Cada cambio de inferencia crea una versión; no sustituye filas anteriores. `FieldCorrection` se vincula al ID lógico, campo y versión sobre la que se hizo, con control optimista. Los campos corregidos o confirmados manualmente no pueden sobrescribirse por inferencias posteriores: el reconciliador genera `conflict` si no puede conservarlos.

Estados de obligación: `candidate` (con evidencia, pendiente de acción), `confirmed` (aceptada), `conflict` (requiere revisión), `paid` (no agenda avisos futuros) y `discarded` (no agenda avisos futuros). Sólo transiciones explícitas del servicio cambian estado; V06 fija la matriz completa.

`Money` usa `{ amount: string_decimal, currency: ISO-4217 }`. `amount` es una cadena decimal base 10 positiva, nunca un número JavaScript ni flotante. No se suman monedas distintas sin una política futura de conversión. Un vencimiento es `{ kind: civil_date, date: YYYY-MM-DD, timeZone: IANA }` o `{ kind: instant, at: RFC3339-con-offset, timeZone: IANA }`. Una fecha sin hora permanece fecha civil en la zona del usuario y no se transforma a medianoche UTC.

## Avisos y IA

`Reminder` conserva objetivo, versión de la obligación, política y programación. `DeliveryAttempt` es inmutable con resultado `sent`, `failed` o `unknown`; un timeout tras envío externo queda `unknown` y no se reintenta a ciegas. Pagar, descartar, borrar o cambiar vencimiento solicita cancelación/reprogramación versionada.

Una llamada de modelo tiene perfil `local-only` o `remote-allowed`. `local-only` nunca puede usar red, fallback remoto ni reintento externo. Sin una ruta válida para el perfil, se bloquea y queda revisable. V05 añade gateway, presupuesto y ledger; V01 sólo reserva este límite de privacidad.
