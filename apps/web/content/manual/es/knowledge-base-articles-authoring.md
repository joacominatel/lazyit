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

## Escribir un artículo

Abre la Base de conocimiento y elige **Nuevo artículo**. El formulario es breve:

- **Título** — el nombre del artículo. El **slug** de la URL se deriva del título automáticamente
  (una forma corta en `minúsculas-con-guiones`); no lo escribes tú.
- **Categoría** — la carpeta principal del artículo. Cada artículo vive en **exactamente una**
  carpeta. Si aún no creaste ninguna carpeta, usa el botón **+** para crear una sin salir del
  formulario. Consulta [Carpetas y acceso](/help/knowledge-base-folders-access).
- **Extracto** *(opcional)* — un resumen de una línea que se muestra en los listados.
- **Contenido** — el cuerpo, en Markdown.

El editor es un editor de Markdown plano con vista previa en vivo: por diseño no hay un modo de texto
enriquecido/WYSIWYG. Los bloques de código se resaltan con sintaxis en la página publicada, cada uno
con un botón de copia, y un bloque ` ```mermaid ` se renderiza como un diagrama. Tú escribes Markdown
en bruto; el formato aparece cuando se ve el artículo.

Mientras escribes, dos ayudas ofrecen autocompletado:

- Escribir `[[` inicia un **enlace wiki** a otro artículo: consulta
  [Enlaces y descubrimiento](/help/knowledge-base-linking-discovery).
- También se admiten referencias a secretos del Gestor de secretos de forma inline; solo ves y eliges
  un identificador (handle), nunca un valor secreto.

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

Una etiqueta **Borrador** marca los artículos no publicados en su página. Editar el cuerpo nunca
cambia el estado de publicado/borrador: publicar y despublicar son acciones explícitas aparte.

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
  artículos — y **solo el autor del artículo** puede editar, publicar o eliminar su propio artículo.
  Un titular del permiso que no sea el autor recibe igualmente un error de permisos.
- Los administradores siempre ven todos los artículos, incluidos los borradores, sin importar las
  restricciones de carpeta.

Consulta [Roles y permisos](/help/permissions) para el conjunto completo de capacidades.
