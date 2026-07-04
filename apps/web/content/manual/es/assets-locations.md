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

## Quitar una ubicación

Las ubicaciones se **borran de forma lógica**, nunca se destruyen. Quitar una ubicación **no** borra
los activos que la referencian — esos activos simplemente quedan sin ubicación en ese vínculo, y el
registro se conserva para el historial. lazyit prioriza la auditabilidad por sobre la prolijidad
estricta.

## Qué sigue

- [Conceptos de activos](/help/assets-asset-basics) — registra unidades y fija su ubicación.
- [Modelos y categorías](/help/assets-models-categories) — clasifica qué es el activo.
