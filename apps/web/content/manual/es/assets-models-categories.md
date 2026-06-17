---
title: Modelos y categorías
category: assets
subcategory: models-categories
order: 1
---

# Modelos y categorías

Los modelos y las categorías te permiten describir tus activos una sola vez a nivel de tipo, en lugar
de repetir los mismos datos en cada unidad. Ambos se gestionan en **Configuración → Taxonomías**.

## Modelos de activo

Un **modelo de activo** es una marca/modelo genérico — por ejemplo "Dell Latitude 7440" o "Cisco
Catalyst 9300". Reúne los datos comunes a todas las unidades de ese modelo, para que los activos
individuales no tengan que repetirlos.

Un modelo tiene un **nombre** (obligatorio), un **fabricante** (obligatorio), un **SKU** opcional, una
descripción opcional, una **categoría** opcional y **valores por defecto** opcionales.

- Los **valores por defecto** son pares clave/valor — por ejemplo "viene con 16GB". Cuando creas un
  activo y eliges este modelo, esos valores se copian en los
  [campos personalizados](/help/assets-asset-basics) del nuevo activo como punto de partida. Luego
  puedes cambiarlos para la unidad concreta antes de guardar.
- Los valores de un modelo son una **instantánea al momento de crear**: editar un modelo más tarde
  **no** reescribe los campos personalizados de los activos ya creados a partir de él, y los valores
  propios de un activo siempre prevalecen sobre los del modelo.
- El **SKU** es único entre los modelos activos cuando se completa, igual que la serie en los activos.

Gestiona los modelos en **Configuración → Taxonomías → Modelos de activo**. El selector de modelo del
formulario de activo permite buscar, así un catálogo largo sigue siendo cómodo de usar.

## Categorías de activo

Una **categoría de activo** clasifica tus modelos — por ejemplo Laptop, Desktop, Servidor, Switch,
Firewall. Las categorías sirven para agrupar y para el filtro de categoría en la lista de Activos.

- Una categoría tiene un **nombre** (obligatorio, único entre las categorías activas), una descripción
  opcional y un ícono opcional.
- lazyit incluye un **conjunto inicial** ya cargado (Servidor, Switch, Router, Firewall, Laptop,
  Desktop, Móvil, Impresora, Almacenamiento, UPS, Periférico, Otro). Son categorías comunes — renómbralas,
  edítalas o quítalas como cualquier otra; no tienen nada especial.
- Un modelo apunta a una categoría, y un activo hereda su categoría **a través de su modelo**. El
  filtro de categoría en la lista de Activos hace coincidir un activo por la categoría de su modelo.

Gestiona las categorías en **Configuración → Taxonomías → Categorías de activo**.

## Cómo encajan

La relación es una cadena simple:

La **categoría** clasifica un **modelo**, y un **modelo** es aquello de lo que un **activo** es una
instancia.

Los tres vínculos son opcionales — un activo puede existir sin modelo, y un modelo sin categoría —
pero completarlos es lo que hace útiles el filtrado, el agrupamiento y los informes.

## Quitar un modelo o una categoría

Los modelos y las categorías se **borran de forma lógica**, nunca se destruyen. Quitar uno **no** borra
ni rompe los activos que lo referencian — esos activos simplemente conservan su instantánea y quedan
sin clasificar en ese vínculo. Así tu historial se mantiene intacto: lazyit prioriza la auditabilidad
por sobre la prolijidad estricta.

## Qué sigue

- [Conceptos de activos](/help/assets-asset-basics) — registra y edita las unidades individuales.
- [Ubicaciones](/help/assets-locations) — controla dónde residen los activos.
