---
title: Importación
category: knowledge-base
subcategory: import
order: 5
---

# Importación

Puedes traer documentos existentes a la Base de conocimiento en lugar de volver a escribirlos: de uno
en uno, o todo un árbol de Markdown a la vez. Usa **Importar** desde la Base de conocimiento.

## Archivos admitidos

| Archivo | Lo que obtienes |
| --- | --- |
| `.md` / `.txt` | Un artículo a partir del texto del archivo |
| `.docx` (Word) | Un artículo — el texto se extrae a Markdown |
| `.zip` | **Importación en lote** — varios artículos, ver abajo |

Se importa el **texto**, y las **imágenes incrustadas en el documento se trasladan** como adjuntos del
artículo (consulta [Imágenes incrustadas](#imagenes-incrustadas) más abajo). El archivo original en sí
**no se almacena**, y los binarios que no sean imágenes no se conservan.

Al importar, eliges:

- una **Categoría** (la carpeta principal donde caen el o los artículos importados), y
- un **Estado** — importar como **Borrador** (privado para ti) o **Publicado**.

Importar es una acción de escritura de artículos y se ejecuta como la **persona** que importa, nunca
como una cuenta de servicio.

## Un solo archivo

Elige un archivo `.md`, `.txt` o `.docx`, escoge una categoría y un estado, e **Importar**. El archivo
se procesa y vas directamente al nuevo artículo. Los archivos grandes tardan un momento.

## Importación en lote desde un `.zip`

Un `.zip` te permite migrar una wiki existente — por ejemplo una carpeta de notas Markdown, o una
bóveda exportada de Obsidian o Notion — en una sola subida.

- **Solo se importan las entradas `.md` y `.txt`**, junto con la **estructura de carpetas** del
  archivo: las carpetas anidadas del zip se recrean como carpetas en la Base de conocimiento, de modo
  que la jerarquía se traslada. Cualquier otra cosa (imágenes, `.docx` dentro del zip, archivos
  ocultos, binarios) se **omite, no se trata como error**.
- **Los enlaces wiki `[[slug]]` dentro de las notas importadas se reconectan** a los artículos recién
  creados cuando es posible, de modo que una bóveda con enlaces cruzados llega ya cableada en lugar de
  como un muro de enlaces muertos. Un enlace que aún no tenga destino se degrada a la habitual mención
  "aún no creado".
- **Los choques de nombre se resuelven automáticamente.** Si el slug de un artículo importado ya está
  ocupado, se le añade un sufijo numérico (`-2`, `-3`, …) en lugar de fallar. Cada renombrado se
  informa.

### Leer los resultados

Una importación en lote se ejecuta en segundo plano y, al terminar, muestra un resumen por elemento
para que nada quede en silencio:

- **Creados** — artículos importados sin incidencias.
- **Renombrados** — importados, pero con sufijo automático en el slug para evitar un choque (se muestra
  el nombre solicitado).
- **Omitidos** — entradas que no se importaron, con el motivo (una entrada de carpeta, un archivo
  oculto, un tipo no admitido o un archivo vacío).

El resumen también informa cuántas carpetas se crearon y cuántos enlaces wiki se reconectaron.
Revísalo y luego cierra el diálogo — una importación en lote no te lleva a un único artículo.

## Límites y seguridad

- Existe un **tamaño máximo de archivo** para las importaciones (un ajuste del servidor; el valor por
  defecto es pequeño). Un archivo demasiado grande se rechaza de entrada con un mensaje claro.
- Los archivos comprimidos se descomprimen en un proceso **aislado y con la memoria limitada**, de
  modo que un `.zip` malicioso o accidentalmente enorme (una "bomba de descompresión") no puede agotar
  el servidor: falla esa importación concreta de forma segura y deja todo lo demás en marcha. Un fallo
  de este tipo es permanente para ese archivo: corrige o reduce el archivo comprimido e impórtalo de
  nuevo.
## Imágenes incrustadas

Las imágenes **incrustadas dentro** de un archivo importado ahora se trasladan automáticamente, de modo
que un runbook migrado de Word o Markdown conserva sus capturas:

- Una imagen pegada en un **`.docx`**, o una imagen en base64 incrustada directamente en **Markdown**,
  se extrae, se guarda como **adjunto** del artículo y se muestra en línea en el artículo importado —
  igual que una imagen que pegas en el editor (consulta
  [Artículos y redacción](/help/knowledge-base-articles-authoring)). Esto también aplica a las entradas
  `.md` dentro de un `.zip`.
- **Lo que no se traslada:** las imágenes **enlazadas** desde la web (`https://…`) se dejan como
  enlaces y no se muestran (lazyit nunca descarga imágenes remotas); los **archivos** de imagen sueltos
  junto a las notas dentro de un `.zip` se omiten; y los dibujos que no son imágenes ráster reales —
  **SVG** o HTML — no se importan. Expórtalos a PNG primero.
- Cada imagen pasa las **mismas comprobaciones que una subida en el editor**: se verifica su tipo real,
  se vuelve a codificar (eliminando metadatos de cámara/ubicación) y cuenta contra el **límite de
  almacenamiento** de adjuntos de tu instancia. Una imagen ilegible se descarta del artículo; si el
  almacenamiento de adjuntos está **lleno**, toda la importación falla con un mensaje claro — libera
  espacio (o pide a tu administrador que suba el límite) e importa de nuevo. Los documentos con una
  cantidad muy grande de imágenes incrustadas conservan solo las primeras varias docenas.

Las referencias que escribas tú a imágenes ya subidas en lazyit (enlaces `attachment:`) se conservan
tal cual.
