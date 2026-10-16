---
title: Ubicaciones
category: assets
subcategory: locations
order: 1
---

# Ubicaciones

Una **ubicación** es donde reside físicamente un activo — una oficina, un datacenter, un rack, un
depósito, o "remoto / con un empleado". Las ubicaciones responden la mitad de la pregunta central del
inventario: no solo *qué* tenemos, sino *dónde está*. Se gestionan desde la sección **Ubicaciones**.

## Agregar una ubicación

Abre **Ubicaciones** y crea una nueva. Una ubicación tiene:

- **Nombre** — obligatorio.
- **Tipo** — obligatorio; cada ubicación se clasifica (más abajo).
- **Ubicación superior** — opcional; anida esta ubicación dentro de otra (ver [Anidar ubicaciones](#anidar-ubicaciones)).
- **Descripción**, **Dirección**, **Piso** y **Notas** — todos texto libre opcional.

El piso es una **etiqueta, no un número** — valores como "PB", "Subsuelo 1" o "Entrepiso" son válidos.

## Tipos de ubicación

Cada ubicación se clasifica con un tipo, elegido de un conjunto fijo:

- **Oficina**
- **Datacenter**
- **Rack**
- **Remoto** — para activos que no están en un sitio fijo (por ejemplo una notebook que tiene un
  empleado).
- **Depósito**
- **Otro**

## Anidar ubicaciones

Las ubicaciones pueden **anidarse** para reflejar cómo está realmente organizada tu infraestructura:
un **datacenter** contiene **racks**, un **sitio** contiene **salas**, y así. Fija la **Ubicación
superior** de una ubicación para colgarla debajo de otra; déjala en **nivel superior** para un sitio
independiente. Una ubicación sin superior es una raíz.

En la página de una ubicación, una **ruta de navegación** (breadcrumb) muestra toda su ascendencia
(por ejemplo `Datacenter → Rack A3`), y cada ancestro enlaza a su propia página. En un activo, el campo
de ubicación muestra la **ruta completa**, no solo la hoja, para que veas de un vistazo que un servidor
vive en `Central → DC1 → Rack A3`.

Puedes re-anidar una ubicación en cualquier momento editándola y cambiando su superior, o promoverla de
nuevo a nivel superior eligiendo **Ninguna (nivel superior)**. Una ubicación **no** puede anidarse
dentro de sí misma ni de uno de sus descendientes (eso crearía un bucle) — lazyit rechaza ese cambio y
explica por qué en el formulario. Anidar es opcional: una lista plana sigue funcionando si no
necesitas la estructura.

## Asignar una ubicación a un activo

La ubicación de un activo se establece en el formulario de activo — es uno de los campos opcionales al
registrar o editar un activo. Ver [Conceptos de activos](/help/assets-asset-basics). La ubicación es
opcional: un activo puede existir sin ella.

Cambiar la ubicación de un activo queda registrado en su actividad, así puedes ver cuándo se movió una
unidad.

## La vista "activos aquí"

Abre una ubicación para ver sus datos junto con los **activos que están actualmente en esa ubicación**
— el inventario físicamente ubicado ahí. Es la respuesta rápida a "¿qué hay en este rack?" o "¿qué hay
en la sucursal?".

## Consumibles dejados en una ubicación

La página de una ubicación también tiene una sección **Consumibles entregados**: los insumos que
**quedaron** ahí —un extintor en el piso 2, cables de repuesto en una sala de comunicaciones— del más
reciente al más antiguo, con la cantidad y la fecha. Usa **Entregar consumible** para registrar uno
nuevo y **Devolver…** cuando vuelve un ítem retornable. Una ubicación es solo un destino: lazyit lleva
un único conteo de stock por consumible, no un conteo por lugar. Consulta
[Movimientos de stock](/help/consumables-stock-movements).

## Quitar una ubicación

Las ubicaciones se **borran de forma lógica**, nunca se destruyen, y quitar una nunca borra lo que la
referencia. Cuando la ubicación todavía tiene **activos**, **ubicaciones hijas** o **compras abiertas**
que se entregan ahí, lazyit primero te muestra qué se verá afectado y te pide **una sola decisión para
todo** — no se puede elegir ítem por ítem:

- **Dejarlos sin ubicación** — los activos quedan sin ubicación, las ubicaciones hijas pasan a ser de
  nivel superior y las compras abiertas quedan sin ubicación de entrega.
- **Moverlos a otra ubicación** — todo pasa a la ubicación que elijas. Debe ser una ubicación activa
  que no esté dentro de la que quitas.
- **Crear una ubicación nueva** — escribe un nombre: lazyit la crea con el mismo tipo y la misma
  ubicación padre que la que quitas (en el nivel superior si esa no tiene padre o su padre fue
  quitado), y luego mueve todo ahí. Si la ubicación nueva se crea pero la baja falla, el diálogo lo
  dice y en el siguiente intento ofrece mover todo a ella, así nunca quedan dos. Esta opción solo
  aparece si también puedes crear ubicaciones.

El diálogo nombra hasta 50 de cada tipo y los cuenta a todos. Si no tienes permiso para ver un tipo
(las compras, por ejemplo), solo ves cuántos hay — la decisión también se aplica a ellos.

El movimiento y la baja ocurren juntos, y cada activo movido registra el cambio de ubicación en su
historial. Lo que ya es historial sigue apuntando a la ubicación quitada: los consumibles entregados
ahí, las compras canceladas o recibidas por completo y los activos archivados. Una ubicación a la que
nada apunta se quita directamente.

Un administrador puede recuperar una ubicación quitada desde la vista de archivados. Restaurarla no
devuelve lo que se movió. Restaurar una ubicación cuyo padre sigue quitado se rechaza: restaura primero
el padre.

## Qué sigue

- [Conceptos de activos](/help/assets-asset-basics) — registra unidades y fija su ubicación.
- [Modelos y categorías](/help/assets-models-categories) — clasifica qué es el activo.
