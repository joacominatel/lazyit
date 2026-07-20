---
title: Enlaces y descubrimiento
category: knowledge-base
subcategory: linking-discovery
order: 3
---

# Enlaces y descubrimiento

La Base de conocimiento conecta los artículos entre sí y con el parque que documentan, de modo que un
runbook nunca quede aislado. Hay tres tipos de conexión. En la página de lectura se reúnen en un
panel **Conexiones** sereno junto al artículo (que pasa debajo del artículo en pantallas estrechas), y
cada sección aparece **solo cuando tiene algo que mostrar**: un artículo sin conexiones es solo su
prosa. Un índice **En esta página** lista los encabezados del artículo y resalta la sección que estás
leyendo a medida que te desplazas.

## Enlaces wiki entre artículos

Dentro del cuerpo de un artículo, escribe `[[slug]]` para enlazar a otro artículo: el mismo enlace al
estilo de Obsidian que usa la propia documentación de este producto. A medida que escribes `[[`, el
editor sugiere los artículos coincidentes para que elijas uno.

- Un `[[slug]]` cuyo destino **existe** se renderiza como un enlace en el que se puede hacer clic en
  la página publicada. Pasa el cursor sobre un enlace que funciona para previsualizar el artículo de
  destino — su título, estado, carpeta y extracto — sin salir de la página.
- Un `[[slug]]` cuyo destino **aún no existe** se renderiza como una mención simple, sin clic, con una
  indicación emergente ("aún no creado"). Esto es una **referencia hacia adelante**: puedes enlazar un
  runbook que piensas escribir a continuación. Cuando crees más tarde ese artículo, el enlace empieza
  a funcionar por sí solo — no tienes que volver a editar el primer artículo.

Guardar un artículo nunca falla por un `[[enlace]]` sin resolver.

## Referencias (retroenlaces)

El panel Conexiones muestra una sección **Referenciado por** que lista los artículos que apuntan **a
él** mediante un enlace wiki `[[slug]]` (con un recuento). Es el reverso de los enlaces anteriores y la
forma más útil de navegar: desde "el runbook de rotación del certificado de la VPN" ves de inmediato
cada runbook que depende de él. Aparece solo cuando al menos un artículo referencia a este.

Las referencias se calculan automáticamente a partir del cuerpo de los demás artículos — no hay nada
que mantener a mano. Menciona un artículo como un `[[slug]]` en algún sitio y aparecerá en las
Referencias de ese artículo.

## Vínculos a activos y aplicaciones

En el panel Conexiones, la sección **Vinculado a** conecta el artículo con tu **inventario**: un
**activo** o una **aplicación**. Esto es lo que hace que la Base de conocimiento sea nativa de TI: un
artículo se convierte en *"el runbook de ESTE servidor"* o *"el procedimiento de acceso de ESTA app"*.
Cuando un artículo enlaza con algo, también aparece una fila compacta de fichas **Incluye** bajo el
título, como resumen de un vistazo.

- Elige **Vincular**, selecciona un tipo de destino (Activo o Aplicación), elige el registro concreto
  y confirma. Cada vínculo apunta a **exactamente un** destino.
- El vínculo es bidireccional. En la propia página del activo o la aplicación, un panel de **artículos
  relacionados** lista los artículos publicados vinculados a él, de modo que quien mire el registro
  encuentre su runbook.
- Quita un vínculo desde la misma sección.

Vincular es una acción de escritura de artículos y, como editar, solo el autor del artículo puede
gestionar sus vínculos. **Vinculado a** (artículo ↔ activo/aplicación) y **Referenciado por** (artículo
↔ artículo) son dos cosas distintas y viven en dos secciones separadas del panel Conexiones — un
artículo puede tener ambas: los activos que documenta *y* los runbooks que lo referencian.

## Búsqueda

Los artículos publicados se pueden buscar por texto completo, incluido su **cuerpo** — no solo
títulos y extractos. Los borradores nunca se indexan, así que un borrador privado nunca puede aparecer
en la búsqueda. Las carpetas restringidas se respetan: la búsqueda nunca revela un artículo que no
tienes permiso para leer.
