---
title: Consumibles y categorías
category: consumables
subcategory: consumables-categories
order: 1
---

# Consumibles y categorías

Un **consumible** es un suministro con conteo de stock: cables, adaptadores, tóner, tornillos. A
diferencia de un activo, que lazyit rastrea pieza por pieza, un consumible es simplemente una
cantidad disponible: te importa *cuántos* tienes, no *cuál*. El listado está en **Consumibles**, en
la barra lateral.

## Agregar un consumible

Abre **Consumibles** y elige **Nuevo consumible**. Un consumible tiene:

- **Nombre** — obligatorio, por ejemplo *Adaptador USB-C a HDMI*.
- **SKU** — número de pieza opcional. Se muestra en monoespaciado y es buscable; no tiene que
  parecer único, pero sí debe serlo entre tus consumibles activos.
- **Categoría** — agrupación opcional (ver más abajo). Elegir una es lo que vuelve útil el filtro
  **Categoría** del listado.
- **Umbral de reposición** — opcional. Cuando el conteo disponible baja a este número o por debajo,
  el ítem se marca como stock bajo. Consulta [Alertas de stock bajo](/help/consumables-low-stock-alerts).
- **Unidad** — la unidad de medida (*unidades*, *metros*, *cajas*…). Es una etiqueta sencilla que
  acompaña al conteo donde sea que se muestre; no cambia ningún cálculo.
- **Descripción** y **Notas** — texto libre opcional.

El stock **no** es un campo que escribas. Un consumible nuevo empieza en **0** disponible, y el
conteo solo cambia mediante movimientos de stock, nunca editando el consumible. Consulta
[Movimientos de stock](/help/consumables-stock-movements).

## El listado

El listado de consumibles muestra el nombre, la categoría, el **Stock** actual, la unidad, el SKU y
cuándo se actualizó cada ítem por última vez. La cifra de stock está codificada por color:

- **Verde** — en stock.
- **Ámbar** — stock bajo (en el umbral de reposición o por debajo).
- **Rojo** — sin stock (0 disponible).

Puedes buscar por nombre o SKU, y filtrar por **Categoría** o por **Solo stock bajo**. Cada fila
incluye además los botones rápidos `−1` / `+1` para ajustar el conteo en el sitio.

## Categorías

Las categorías (Cables, Adaptadores, Periféricos, Material de oficina, Otros, …) son una agrupación
opcional que gestionas tú. **No** se configuran en el formulario del consumible: las creas y editas
en **Configuración → Taxonomías**, en la pestaña Consumibles. lazyit incluye un conjunto inicial
pequeño; renómbralo, amplíalo o recórtalo según tu parque.

Conviene saber algunas cosas:

- Un consumible puede tener **una** categoría, o ninguna.
- **Eliminar una categoría no elimina sus consumibles.** Cada consumible que apuntaba a ella
  simplemente queda sin categoría; no se pierde nada. (Esto difiere de otras partes de lazyit que
  bloquean una eliminación mientras algo sigue referenciando el ítem.)
- Las categorías se **eliminan de forma reversible** y un nombre eliminado queda libre para
  reutilizarse, así que puedes recrear o restaurar una más adelante sin conflicto.

## Editar, clonar y eliminar

Desde la página de detalle de un consumible o desde el menú de su fila puedes **Editar**, **Clonar**
o **Eliminar**.

- **Clonar** abre un consumible nuevo precargado a partir del original. El SKU se borra y el stock
  empieza en cero, práctico para dar de alta una pieza casi idéntica.
- **Eliminar** es una eliminación reversible: el consumible se archiva, no se borra, y se conserva su
  historial de movimientos. Los administradores pueden pasar el listado a la vista de archivados y
  **Restaurar** el ítem.
