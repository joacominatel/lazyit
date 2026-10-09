---
title: Artículos y redacción
category: knowledge-base
subcategory: articles-authoring
order: 1
---

# Artículos y redacción

La Base de conocimiento es donde tu equipo guarda sus **runbooks, procedimientos y notas**: la
documentación de tu propio parque. Es distinta de este Manual: el Manual documenta *lazyit en sí*, la
Base de conocimiento documenta *tus servidores, tus aplicaciones, tus procesos*.

Un **artículo** es un único documento en Markdown. Lo escribes en Markdown plano, lo previsualizas
mientras avanzas y lo publicas cuando está listo.

## Explorar la Base de conocimiento

La Base de conocimiento se abre en su **página de inicio**: el título con una línea de cifras
(cuántos artículos puedes ver, cuántos están publicados, cuántos borradores son tuyos y cuántas
carpetas hay), un cuadro de búsqueda, las **carpetas** de primer nivel como tarjetas y la tabla de
**artículos**.

### La barra lateral: vistas y carpetas

La barra lateral de la izquierda tiene dos partes. Las **Vistas** son accesos fijos:

- **Todos los artículos** — la página de inicio, con el número de artículos que puedes ver.
- **Mis borradores** — tus artículos sin publicar. Los borradores son privados de su autor, así que
  esta lista solo contiene los tuyos.
- **Recientes** — los artículos **que abriste en este navegador**, del más reciente al más antiguo
  (hasta 20). La lista se guarda solo en este dispositivo, en este navegador: no se envía al servidor,
  no se comparte con nadie y no se sincroniza con tus otros dispositivos. Una ventana privada o los
  datos del sitio bloqueados simplemente la empiezan vacía. **Vaciar lista** la borra.
- **Vinculados a activos y apps** — artículos conectados con al menos un activo o una aplicación.

Debajo, **Carpetas** es el árbol de carpetas — consulta [Carpetas y acceso](/help/knowledge-base-folders-access).
La entrada resaltada siempre coincide con la página en la que estás, así que un enlace compartido se
abre con la misma vista o carpeta seleccionada. En una pantalla estrecha la barra lateral se pliega
tras un botón **Vistas y carpetas**.

### La tabla de artículos

Los artículos se listan como una tabla:

- **Artículo** — el título, una etiqueta **Borrador** en los artículos sin publicar (pasa el puntero
  por encima: *solo tú lo ves hasta que lo publiques*), el número de vínculos cuando el artículo está
  vinculado a activos o apps, y el extracto debajo (o *Sin resumen* cuando no tiene).
- **Carpeta** — la ruta completa de la carpeta del artículo, con un candado cuando esa carpeta está
  restringida.
- **Autor** — quién lo escribió; un compañero que ya no está se marca como **Ex-miembro**.
- **Lectura** — el tiempo de lectura estimado.
- **Actualizado** — hace cuánto cambió por última vez; pasa el puntero por encima para ver la fecha y
  la hora exactas.

En una pantalla estrecha cada artículo pasa a ser una fila de dos líneas con su carpeta y su fecha
debajo del título. Sobre la tabla:

- **Todos / Publicados / Borradores** filtra por estado, cada opción con su número. **Borradores** es
  la misma lista que **Mis borradores**.
- **Orden** ordena la lista por **Actualizados** (lo más reciente primero, por defecto), **Título** (de
  la A a la Z) o **Creados** (lo más reciente primero).
- **Filtros** reduce la lista a los artículos **vinculados** a activos o aplicaciones: cualquiera, un
  tipo o algunos concretos. Los filtros activos se muestran como chips que puedes quitar uno a uno.

Cada elección queda en la dirección de la página, así que puedes guardar o compartir una lista
filtrada.

### Buscar

El cuadro de búsqueda busca en el **texto completo** de todos los artículos que puedes leer: títulos y
cuerpos. Pulsa `/` para ir a él desde cualquier punto de la página, o `⌘K` (`Ctrl K`) para abrir un
buscador rápido que salta directamente a un artículo. Cada resultado muestra resaltadas las palabras
que coinciden, la **carpeta** del artículo y **hace cuánto se actualizó**. La búsqueda abarca toda la
Base de conocimiento, no solo la carpeta en la que estás. Justo después de una actualización, hasta
que la búsqueda se reindexa, los resultados recurren a coincidencias en títulos y extractos — una nota
lo indica — y en algunos resultados pueden faltar la carpeta y la fecha.

## Escribir un artículo

Abre la Base de conocimiento y elige **Nuevo artículo** — o **Artículo aquí** en la página de una
carpeta, que abre el formulario con esa carpeta ya elegida como **Categoría**. El formulario es breve:

- **Título** — el nombre del artículo. El **slug** de la URL se deriva del título automáticamente
  (una forma corta en `minúsculas-con-guiones`); no lo escribes tú.
- **Categoría** — la carpeta principal del artículo. Cada artículo vive en **exactamente una**
  carpeta. Elígela desde la **lista de carpetas con búsqueda**: escribe para filtrar por la ruta
  completa de la carpeta (por ejemplo, *Servidores / Linux*), así es fácil encontrar la correcta
  incluso en un árbol profundo. Si aún no creaste ninguna carpeta, usa el botón **+** para crear una
  sin salir del formulario. Consulta [Carpetas y acceso](/help/knowledge-base-folders-access).
- **Extracto** *(opcional)* — un resumen de una línea que se muestra en los listados.
- **Contenido** — el cuerpo, en Markdown.

El editor es un editor de Markdown plano con vista previa en vivo: por diseño no hay un modo de texto
enriquecido/WYSIWYG. El formulario le da al editor un **ancho amplio y cómodo**, y las acciones
**Guardar / Crear borrador** van en una barra que **queda siempre al alcance** mientras te desplazas
por un artículo largo. Los bloques de código se resaltan con sintaxis en la página publicada, cada uno
con un botón de copia, y un bloque ` ```mermaid ` se renderiza como un diagrama. Tú escribes Markdown
en bruto; el formato aparece cuando se ve el artículo.

Los diagramas usan el aspecto actual de Mermaid: distribución automática y un tema en color que sigue
el modo claro u oscuro. Los diagramas escritos antes de una actualización se renderizan con la nueva
distribución, así que pueden verse distintos aunque su código no haya cambiado.

Las etiquetas de los diagramas son texto plano. Las etiquetas HTML dentro de una etiqueta (`<b>`,
`<img>`, enlaces) se muestran tal cual están escritas en lugar de aplicarse, y la configuración del
diagrama en el código no puede cambiarlo. Para un salto de línea en una etiqueta usa `<br>`; para
negrita o cursiva, usa una cadena Markdown como ``A["`**Devolver** activo`"]``.

Si el cerco de un bloque de código **no tiene** marcador de lenguaje, lazyit hace una mejor conjetura
al momento de mostrarlo y lo etiqueta como **auto** (por ejemplo, ` ```def sum(a, b): return a + b``` `
se resalta como Python). Un lenguaje explícito en el cerco siempre tiene prioridad, y un bloque ambiguo
se deja como texto plano en lugar de etiquetarse mal, así que agregar el lenguaje al cerco sigue siendo
la forma confiable de asegurarte.

Mientras escribes, dos ayudas ofrecen autocompletado:

- Escribir `[[` inicia un **enlace wiki** a otro artículo: consulta
  [Enlaces y descubrimiento](/help/knowledge-base-linking-discovery).
- También se admiten referencias a secretos del Gestor de secretos de forma inline; solo ves y eliges
  un identificador (handle), nunca un valor secreto.

### Empezar desde un archivo Markdown

En la pantalla **Nuevo artículo** puedes partir de un archivo que ya tengas: **arrastra un archivo
Markdown sobre el formulario** y su texto se vuelca directamente en **Contenido**. Mientras arrastras
aparece una capa serena con "Suelta un archivo `.md` para importar su contenido". ¿Prefieres no
arrastrar? Usa el botón **Elegir un archivo `.md`** de la misma barra para elegirlo — el camino
accesible por teclado hace exactamente lo mismo.

- Los archivos admitidos son **`.md`, `.markdown` y `.txt`**, hasta **1 MB**. Cualquier otro se
  rechaza con un aviso breve — esto solo importa texto, así que las imágenes y otros tipos de archivo
  no se admiten aquí (para imágenes, consulta [Añadir imágenes](#añadir-imágenes) más abajo).
- El archivo se lee **solo en tu navegador** — no se sube nada. Simplemente rellena el editor, y el
  artículo se crea cuando pulsas **Crear borrador**, igual que si lo hubieras escrito.
- Si el **Título** sigue vacío, se rellena a partir del primer `# Encabezado` del archivo (antes se
  omite un bloque de frontmatter YAML `---` inicial), o a partir del nombre del archivo. Un título que
  ya hayas escrito nunca se sobrescribe.
- Si el editor **ya tiene contenido**, la importación te pide **confirmar antes de reemplazarlo**,
  para que un arrastre accidental nunca borre el trabajo en curso.

Es una forma rápida de empezar un borrador a partir de notas — para traer documentos de Word o una
carpeta entera de Markdown de una vez, usa **Importar** (consulta
[Importar artículos](/help/knowledge-base-import)).

### Ayuda de formato (el botón `?`)

Un **botón `?`** en la barra de herramientas del editor abre una breve **chuleta de formato** para
que nunca escribas "a ciegas". Cubre el Markdown plano (encabezados, negrita/cursiva, código, listas)
y — lo más útil — los dos **tokens reservados** de lazyit, cada uno con un ejemplo copiable:

- **Enlazar otro artículo** — `[[slug-del-articulo]]`, o `[[slug-del-articulo|Texto a mostrar]]` para
  un texto de enlace personalizado. Un enlace a un artículo que aún no existe queda como referencia
  futura.
- **Referenciar un secreto** — `{{ lazyit_secret.handle }}`, que se renderiza como un chip enmascarado
  que solo un miembro del vault puede revelar: consulta
  [Referencias a secretos](/help/secret-manager-secret-references).
- **Enlace externo** — un enlace Markdown estándar `[texto](https://…)` a cualquier sitio fuera de la
  Base de conocimiento.

Copia un ejemplo, pégalo en el cuerpo y la vista previa en vivo muestra exactamente cómo se resuelve
el token. El mismo `?` y la vista previa están disponibles tanto en **Nuevo artículo** como en
**Editar**.

### Tu trabajo está protegido

El editor evita perder el trabajo en curso:

- **Autoguardado local** — mientras escribes, tu borrador se guarda en **este navegador** cada pocos
  segundos. Es una red de seguridad privada en tu propio equipo, *no* un guardado en el servidor: el
  artículo solo cambia cuando pulsas **Crear borrador** / **Guardar cambios**. Si la pestaña falla o
  se cierra por accidente, no se pierde nada.
- **Restaurar al volver** — vuelve a abrir **Nuevo artículo** o **Editar** y, si hay un borrador local
  sin guardar, un aviso ofrece **Restaurarlo** (o **Descartarlo**). Un artículo guardado nunca se
  sobrescribe sin tu permiso.
- **Aviso al salir** — cerrar la pestaña, recargar o pulsar **Cancelar** con cambios sin guardar te
  pide confirmación antes de descartarlos. Un guardado correcto borra el borrador local.

El borrador local vive solo en el navegador donde lo escribiste; no se comparte con tu equipo ni se
sincroniza entre dispositivos.

## Borradores y publicación

Todo artículo nuevo nace como **Borrador**. Un borrador es **privado de su autor**: nadie más puede
verlo, y un compañero que adivine su dirección obtiene una página de "artículo no encontrado", no un
error de permisos, de modo que ni siquiera se revela que el borrador existe.

Publica desde el propio artículo:

- **Publicar** — pasa el artículo a **Publicado** y lo hace visible para el equipo (sujeto a las
  reglas de acceso de su carpeta). La primera publicación deja una fecha de publicación que nunca se
  borra.
- **Despublicar** — devuelve un artículo publicado a **Borrador**, ocultándolo de nuevo para todos
  excepto su autor.

Una etiqueta **Borrador** marca los artículos no publicados en su página y en la tabla de artículos,
y **Mis borradores** en la barra lateral reúne todos los tuyos. Editar el cuerpo nunca
cambia el estado de publicado/borrador: publicar y despublicar son acciones explícitas aparte.

## Añadir imágenes

Puedes poner capturas y diagramas directamente en un artículo. La forma más rápida es **pegar**:
copia una imagen al portapapeles y pégala en el panel de origen del editor — lazyit la sube e
inserta una referencia de imagen en el cursor. También puedes **arrastrar y soltar** un archivo de
imagen sobre el editor, o usar el botón **Insertar imagen** de la barra del editor para elegir una.

- Los tipos admitidos son **PNG, JPEG, GIF y WebP**, hasta **10 MB** cada uno. Otros formatos —
  incluido **SVG** — se rechazan; exporta los diagramas a PNG.
- Las imágenes pertenecen al artículo, así que **guarda primero el borrador**. En un artículo nuevo
  que nunca se ha guardado todavía no hay dónde adjuntar una imagen, así que al pegar verás un aviso
  de "guarda primero el borrador".
- Mientras la imagen se sube verás un marcador `![subiendo …]()` en el panel de origen; se
  reemplaza por la referencia real automáticamente al terminar la subida.
- Las imágenes se muestran en el artículo publicado y en la vista previa, y se sirven **solo** a
  quienes ya pueden leer el artículo — una imagen nunca queda expuesta en una URL pública.
- Solo se almacenan los archivos que pegas, sueltas o subes. Un enlace escrito a mano a una imagen de
  la web **no** se muestra (no se cargan imágenes externas); conserva las capturas como adjuntos.

## Editar y eliminar

- **Editar** abre el mismo formulario sobre el artículo existente. Guardar actualiza el cuerpo; no
  cambia si el artículo está publicado. Cada edición que cambia el título, el cuerpo o el extracto se
  registra en el historial del artículo: consulta [Versionado](/help/knowledge-base-versioning).
- **Eliminar** quita el artículo de la Base de conocimiento. Es una **eliminación lógica**: la fila se
  conserva, no se borra, de modo que puede restaurarse desde la base de datos si hace falta. Su slug
  también queda libre para que un artículo nuevo reutilice el nombre.

## Quién puede hacer qué

La redacción está gobernada por los permisos de la Base de conocimiento, y la API exige además la
**autoría**:

- Leer la Base de conocimiento requiere el permiso de lectura de artículos, que todos los roles
  tienen por defecto.
- Crear, importar, editar, publicar, despublicar y vincular requieren el permiso de escritura de
  artículos. Por defecto, un redactor normal solo puede editar, publicar o eliminar **sus propios**
  artículos — un titular del permiso de escritura que no sea el autor recibe un error de permisos en
  el artículo de otra persona.
- **Editar cualquier artículo.** Dos tipos de usuario quedan exentos de la regla de solo-autor para
  que un runbook nunca quede bloqueado por un autor no disponible: los **administradores** (que
  siempre pueden editar, publicar, eliminar y restaurar cualquier artículo) y los titulares de la
  capacidad **«Editar cualquier artículo»** (`article:manage`). Es un permiso que un administrador
  puede otorgar a un compañero de confianza. Solo omite la **autoría**: la persona sigue necesitando
  el permiso de escritura para editar (o el de eliminación para eliminar), y un titular que no sea
  administrador tampoco puede tocar un artículo en una carpeta que no puede ver. **La atribución nunca
  se pierde:** el autor original permanece registrado y cada edición queda marcada con quién la hizo
  realmente en el historial de versiones del artículo.
- Los administradores siempre ven todos los artículos, incluidos los borradores, sin importar las
  restricciones de carpeta.

Consulta [Roles y permisos](/help/permissions) para el conjunto completo de capacidades.
