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

El campo **fabricante** sugiere los fabricantes que ya usan tus otros modelos (y, si puedes ver las
compras, tus líneas de compra) — los más usados primero, con cuántos registros usa cada uno — y avisa cuando lo que escribiste es otra forma de escribir uno
existente (por ejemplo `DELL` o `Dell Inc.` para `Dell`), para que una marca no termine partida en dos.
Funciona como el campo [Empresa](/help/assets-asset-basics) del activo, y siempre puedes escribir un
fabricante nuevo.

- Los **valores por defecto** son pares clave/valor — por ejemplo "viene con 16GB". Cuando creas un
  activo y eliges este modelo, esos valores se copian en los
  [campos personalizados](/help/assets-asset-basics) del nuevo activo como punto de partida. Luego
  puedes cambiarlos para la unidad concreta antes de guardar.
- Los valores de un modelo son una **instantánea al momento de crear**: editar un modelo más tarde
  **no** reescribe los campos personalizados de los activos ya creados a partir de él, y los valores
  propios de un activo siempre prevalecen sobre los del modelo.
- El **SKU** es único entre los modelos activos cuando se completa, igual que la serie en los activos.
- El **SKU** y la **descripción** también se pueden quitar después: al editar un modelo, vacía el campo
  y guarda, y el modelo deja de tenerlo.
- La **categoría** es opcional y se puede quitar después: al editar un modelo, elige **Sin categoría**
  al principio de la lista de categorías y guarda. El modelo (y todos sus activos) queda sin categoría,
  así que ya no coincide con el filtro de categoría de la lista de Activos.

Gestiona los modelos en **Configuración → Taxonomías → Activos → Modelos**. El selector de modelo del
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

Gestiona las categorías en **Configuración → Taxonomías → Activos → Categorías**.

### Diccionario de specs (sugerencias de campos)

Una categoría también puede declarar un **diccionario de specs** opcional — una lista de los
[campos personalizados](/help/assets-asset-basics) que esperás en los activos de ese tipo (por
ejemplo, que todo Servidor tenga `cpu`, `ramGb` y un `formFactor`). Es una ayuda de consistencia
liviana, no una camisa de fuerza.

- Cada campo tiene una **clave** (el nombre del campo personalizado que gobierna), una **etiqueta**, un
  **tipo** (texto, número, sí/no o una lista de **opciones**) y se puede marcar como **obligatorio**.
  Un campo de opciones enumera sus valores permitidos.
- El diccionario es **orientativo**: cuando editás un activo cuyo modelo pertenece a esta categoría, se
  sugieren los campos declarados a medida que escribís y lazyit muestra **avisos suaves** — un campo
  obligatorio vacío, un valor que no coincide con su tipo, una opción fuera de la lista o un campo
  personalizado que no está en el diccionario. **Nada se bloquea**: siempre podés guardar, y los
  activos existentes nunca se modifican ni se invalidan.
- Dejá el diccionario vacío para no tener governance (lo predeterminado) — se aceptan cualquier campo
  personalizado, igual que antes.
- Editar el diccionario más tarde **no** reescribe los activos ya guardados; solo cambia las
  sugerencias que se muestran la próxima vez que alguien edite uno.

Definí el diccionario de una categoría desde su editor en **Configuración → Taxonomías → Activos →
Categorías**.

## Cómo encajan

La relación es una cadena simple:

La **categoría** clasifica un **modelo**, y un **modelo** es aquello de lo que un **activo** es una
instancia.

Los tres vínculos son opcionales — un activo puede existir sin modelo, y un modelo sin categoría —
pero completarlos es lo que hace útiles el filtrado, el agrupamiento y los informes.

## Quitar un modelo o una categoría

Los modelos y las categorías se **borran de forma lógica**, nunca se destruyen, y quitar uno nunca borra
lo que lo referencia. Cuando todavía está en uso, lazyit primero te muestra qué se verá afectado y te
pide **una sola decisión para todo** — no se puede elegir ítem por ítem.

**Quitar un modelo** que todavía tiene **activos**, o **líneas de compras abiertas** asociadas a él,
ofrece:

- **Dejarlos sin modelo** — los activos conservan sus datos pero quedan sin modelo, y las líneas de
  compra pierden su modelo asociado.
- **Moverlos a otro modelo** — todo pasa al modelo que elijas. Puede ser de otra categoría: la
  categoría de un activo viene de su modelo, así que los activos pasan a mostrar esa categoría.
- **Crear un modelo nuevo** — escribe un nombre: lazyit lo crea con el mismo fabricante y la misma
  categoría que el que quitas, y luego mueve todo ahí. Esta opción solo aparece si también puedes crear
  modelos.

**Quitar una categoría** que todavía tiene **modelos** ofrece las mismas tres opciones para esos
modelos: dejarlos sin categoría, moverlos a otra categoría o crear una categoría nueva y moverlos ahí.
Sus activos siguen a su modelo, así que el diálogo también cuenta los activos cuya categoría cambia.

El diálogo nombra hasta 50 de cada tipo y los cuenta a todos. Si no tienes permiso para ver un tipo
(las compras, por ejemplo), solo ves cuántos hay — la decisión también se aplica a ellos.

El movimiento y la baja ocurren juntos, y cada activo que sale de un modelo registra el cambio de modelo
en su historial. Lo que ya es historial sigue apuntando al modelo o la categoría quitados: los activos y
modelos archivados, las líneas de compra ya recibidas y las líneas de compras canceladas. Un modelo o
una categoría a los que nada apunta se quitan directamente.

Un administrador puede recuperar un modelo quitado desde la vista de archivados. Restaurar un modelo o
una categoría no devuelve lo que se movió. Restaurar un modelo cuya categoría sigue quitada se rechaza:
restaura primero la categoría.

## Qué sigue

- [Conceptos de activos](/help/assets-asset-basics) — registra y edita las unidades individuales.
- [Ubicaciones](/help/assets-locations) — controla dónde residen los activos.
