---
title: Vista rápida
order: 1
category: notifications-activity
subcategory: quick-view
---

# Vista rápida

La vista rápida es un pequeño **ojo** que aparece en cada fila de los selectores de entidades — los
desplegables que usás para elegir un activo, una persona, un modelo, una aplicación o una ubicación
al asignar, otorgar acceso o vincular un registro. El mismo ojo aparece también en los **filtros de
selección múltiple** — por ejemplo cuando filtrás la base de conocimiento por los activos o las
aplicaciones específicas con las que se relaciona un artículo. Abre una vista previa generosa de esa
fila **sin salir de lo que estás haciendo**, para que puedas distinguir entradas parecidas antes de
elegir una.

Existe porque una fila de un selector es necesariamente escueta: un activo se muestra por su nombre,
una persona como "Juan D.", un modelo como "Dell Latitude". Cuando dos filas se parecen — dos
notebooks del mismo modelo, dos personas con el mismo nombre — el ojo te deja confirmar cuál es cuál
en el lugar.

## Abrir una vista previa

Pasá el mouse por una fila y el **ojo** aparece en su borde derecho. Hay dos maneras de usarlo:

- **Pasá el mouse** sobre el ojo un instante y se abre una **vista previa** al lado de la fila.
  Alejate y se cierra sola. Es el vistazo rápido de "déjame chequear".
- **Hacé clic** en el ojo para **fijar** la vista previa abierta. Una vista previa fijada se queda
  hasta que la cerrás y agrega un enlace **«Abrir ficha completa»**.

Solo hay una vista previa abierta a la vez: abrir el ojo de otra fila cierra la anterior.

## Usar el teclado

- Movete por la lista con las flechas **↑ / ↓**. El **ojo se muestra en la fila resaltada**, así ves
  de un vistazo qué filas tienen vista previa.
- Presioná **Alt + Enter** para **abrir y fijar** la vista previa de la fila resaltada — igual que si
  hicieras clic en su ojo. Una pequeña ayuda **Alt ↵** al pie de la lista te lo recuerda.
- Presioná **Esc** para cerrar la vista previa y volver a la lista, justo donde estabas, así seguís
  navegando con las flechas.

Escribir para filtrar, las flechas **↑ / ↓** y **Enter** para elegir una fila siguen funcionando
exactamente igual que antes — **Alt + Enter** es el único atajo que se agrega, y nunca selecciona la
fila.

## Qué muestra una vista previa

La vista previa se adapta al tipo de registro:

- **Activo** — número de serie y etiqueta, modelo (fabricante + nombre), categoría, ubicación y su
  estado.
- **Persona** — email, rol, usuario, legajo, responsable jerárquico y cuántos activos y accesos a
  aplicaciones tiene actualmente, con su avatar de iniciales.
- **Modelo** — fabricante, SKU y descripción.
- **Aplicación** — proveedor, dirección web y descripción.
- **Ubicación** — tipo, dirección, piso y descripción.

Los valores vacíos simplemente se omiten, así que la vista previa nunca muestra una etiqueta en
blanco.

## Abrir la ficha completa

Cuando una vista previa está **fijada** y el registro tiene su propia página de detalle, aparece
abajo un enlace **«Abrir ficha completa»**. Abre la página de ese registro en una **pestaña nueva**,
para que tu flujo actual — el formulario que estabas completando — no se interrumpa. Los modelos de
activo y otros registros que no tienen página propia no muestran el enlace.

## Qué nunca muestra

La vista rápida reutiliza información que el selector **ya cargó**, así que abrir una vista previa no
cuesta una espera extra ni un pedido adicional. También es deliberadamente limitada:

- **Nunca muestra secretos.** Una vista previa solo referencia un secreto por su nombre, nunca su
  valor.
- La **dirección web** de una aplicación se muestra como texto plano, y solo cuando es una dirección
  segura — un enlace inseguro o con scripts se descarta en lugar de mostrarse.

Como la vista previa refleja el resumen que el selector tiene de un registro, algunos campos que solo
están en el detalle (por ejemplo las especificaciones técnicas completas de un activo) no aparecen
ahí — usá **Abrir ficha completa** para ver todo.
