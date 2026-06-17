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

Solo se importa el **texto**. El archivo original **no se almacena**, y las imágenes u otros binarios
dentro de un documento no se conservan.

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
