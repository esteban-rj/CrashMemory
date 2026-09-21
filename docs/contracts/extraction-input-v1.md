# Entrada persistida de extracción v1

Este contrato aditivo fija la frontera entre Gmail (V04) y extracción (V05) sin ampliar el MVP. Toda consulta exige el `userId` de la sesión; las claves foráneas compuestas impiden mezclar objetos de otros usuarios o revisiones.

```ts
interface ExtractionInputV1 {
  sourceItemRevisionId: string;
  body: {
    blobId: string;
    contentSha256: string;
    utf16Length: number;
    normalizationVersion: string;
  };
  attachments: Array<{
    id: string;
    blobId: string;
    fileName: string;
    mediaType: string;
    byteSize: number;
    contentSha256: string;
  }>;
}
```

V04 guarda el mensaje original como el blob de `SourceItemRevision`, el cuerpo normalizado UTF-8 en `source_revision_bodies` y cada adjunto descargado en `source_attachments`. En el MVP sólo un adjunto con `mediaType = "application/pdf"` es entrada documental para V05; los demás siguen preservados, pero no autorizan parsers adicionales.

Los offsets de evidencia de cuerpo se cuentan en unidades UTF-16 sobre el contenido exacto del blob del cuerpo. La normalización debe cambiar `normalizationVersion` cuando cambie su algoritmo. La evidencia PDF referencia `source_attachments.id`; una FK compuesta exige que ese adjunto pertenezca al mismo usuario y a la misma revisión de la evidencia. V05 conserva texto extraído por página en sus artefactos propios y usa el hash de ese texto como `contentSha256` de la evidencia.

`SourceRepository.getExtractionInput(userId, revisionId)` es la API canónica de repositorio. Devuelve `null` si la revisión o el cuerpo normalizado no pertenecen al usuario, y nunca revela rutas ni bytes de otro dueño.
