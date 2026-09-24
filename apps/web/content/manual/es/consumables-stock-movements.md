---
title: Movimientos de stock
category: consumables
subcategory: stock-movements
order: 2
---

# Movimientos de stock

Nunca escribes directamente el conteo de stock de un consumible. Cada cambio en el conteo se
registra como un **movimiento de stock**, y la cifra disponible que ves se mantiene al día con esos
movimientos. La lista de movimientos es un **registro de solo anexado**: el historial corrido de
todo lo que le ha pasado al stock de un consumible, y es la fuente de verdad. Si todavía no has
creado un consumible, lee primero [Consumibles y categorías](/help/consumables-consumables-categories).

## Los tres tipos de movimiento

- **Entrada** — suma al conteo (una reposición, una entrega nueva).
- **Salida** — resta del conteo (entregaste o consumiste algunos).
- **Ajuste** — fija el conteo en un número exacto. Úsalo para un reconteo físico, cuando lo que hay
  en el estante ya no coincide con lo que lazyit cree.

Todo movimiento registra una cantidad **positiva**; el *tipo* (Entrada / Salida / Ajuste) decide qué
le pasa al conteo. Una **Salida** nunca puede dejar el stock por debajo de cero: si intentas quitar
más de lo disponible, lazyit lo rechaza y no se registra nada.

## Ajuste rápido (el caso común)

El camino rápido es el par `−1` / `+1` en cada fila del listado de consumibles y en el panel de Stock
de la página de detalle. Un clic registra una **Salida** o **Entrada** de cantidad 1 y el conteo se
actualiza al instante. El botón `−1` se desactiva cuando hay 0 disponibles. Esto cubre el cotidiano
"tomé uno / devolví uno" sin completar un formulario. Los botones rápidos nunca indican un destinatario: un `−1` es una salida
simple, no una entrega. Para registrar quién recibió las unidades o dónde quedaron, usa **Quitar…**
(abajo).

## El formulario detallado (ser específico)

En la página de detalle de un consumible, los botones **Agregar…**, **Quitar…** y **Ajustar…** abren
un diálogo donde eliges:

- una **cantidad** (un número entero, 1 o más),
- y, de forma opcional, un **Motivo** (una línea corta, por ejemplo *reposición*, *entregado a Ada*)
  y **Notas**.

En **Quitar**, el diálogo te avisa en línea si la cantidad supera lo disponible; el conteo se aplica
de todos modos al enviar. **Quitar** también tiene un campo opcional **Entregar a**: consulta la
sección siguiente. En **Ajustar**, el campo de cantidad pasa a ser un **nuevo conteo de
stock** —el número que contaste de verdad en el estante— y lazyit fija lo disponible exactamente en
ese valor.

## Entregas a una persona, un activo o una ubicación

Una salida puede indicar **adónde fueron las unidades**. En el diálogo **Quitar…**, **Entregar a** es
*Nadie* por defecto (una salida simple, igual que antes); elige **Una persona**, **Un activo** o
**Una ubicación** y selecciona una de la lista de búsqueda. Así la salida pasa a ser una **entrega**:

- **A una persona**: dos adaptadores HDMI entregados a Ana.
- **A un activo**: un tóner colocado en la impresora del 3.er piso, un disco de repuesto dejado en un
  servidor.
- **A una ubicación**: un extintor dejado en el piso 2. Una ubicación es solo el lugar donde
  **quedaron** las unidades; lazyit no lleva un stock separado por lugar.

Un solo destinatario por entrega. Solo se ofrecen entradas vigentes: una persona dada de baja, un
activo eliminado o una ubicación archivada no pueden recibir una entrega nueva. Para repartir una
entrega entre dos destinatarios, registra dos salidas.

Una entrega sigue siendo una **Salida** común: saca las unidades del estante y no puede dejar el
stock por debajo de cero. Además aparece donde la buscarías:

- en el panel **Movimientos** del consumible, en la columna **Entregado a** (con enlace a la persona,
  el activo o la ubicación);
- en la página del propio destinatario, en una sección **Consumibles entregados**: la página de la
  persona, la del activo o la de la ubicación;
- en el caso de un activo, también en su línea de tiempo de **Actividad** como **Consumible
  entregado**. Consulta [Asignaciones e historial](/help/assets-assignments-history).

También puedes iniciar una entrega desde el lado del destinatario: la sección **Consumibles
entregados** tiene un botón **Entregar consumible** (eliges el consumible, la cantidad y notas
opcionales). Registra el mismo movimiento.

Si no tienes permiso para ver personas, activos o ubicaciones, el destinatario de una entrega aparece
como *restringido*: ves que las unidades fueron a alguien o a algún lugar, pero no a quién.

## Ítems retornables y devoluciones

Algunos insumos vuelven: unos auriculares en préstamo, el control de un proyector, un cargador de
repuesto. Marca esos consumibles como **Retornable** en su formulario (consulta
[Consumibles y categorías](/help/consumables-consumables-categories)). La página del consumible
muestra entonces una pequeña marca **Retornable**.

Una entrega de un ítem retornable queda **pendiente** hasta que se devuelve:

- La sección **Consumibles entregados** del destinatario muestra *N pendientes* en esa entrega, y un
  botón **Devolver…** (para quienes pueden registrar movimientos de stock). **Solo pendientes** acota
  la lista a lo que sigue afuera; un filtro de fechas la acota según cuándo se entregó.
- **Devolver…** pregunta cuántas unidades volvieron: por defecto, todo lo que sigue pendiente. Una
  devolución **parcial** está bien; el resto sigue pendiente. No puedes devolver más de lo pendiente.
- Una devolución es una **Entrada** vinculada a su entrega: las unidades vuelven al estante, y el panel
  **Movimientos** del consumible la muestra como *Devolución de la entrega #N*, mientras la fila de la
  entrega muestra cuántas volvieron y cuántas siguen pendientes.

Si una entrega se debe devolver queda fijado **en el momento de hacerla**. Activar o desactivar
**Retornable** más adelante solo cambia las entregas futuras; las pasadas conservan su sentido. Una
entrega no retornable es simplemente un registro de adónde fueron las unidades; no hay nada que
devolver.

Cuando alguien se va, sus ítems pendientes aparecen en la hoja de baja y en el acta de devolución
impresa. Consulta [Ciclo de vida del usuario](/help/users-permissions-user-lifecycle).

## El registro es permanente

Los movimientos son **inmutables**: una vez registrado, un movimiento no se edita ni se elimina. Si
algo salió mal, lo corriges registrando otro movimiento: una **Entrada**/**Salida** contraria, o un
**Ajuste** al conteo correcto. Esto es intencional: el historial del stock de un consumible se
mantiene honesto y auditable. Lo mismo vale para entregas y devoluciones: una devolución equivocada se
corrige con otro movimiento, nunca editándola.

El panel **Movimientos** de la página de detalle lista cada movimiento del más nuevo al más antiguo,
mostrando su tipo, la cantidad con signo (`+`, `−` o `=`), adónde fue una entrega (o qué entrega
devuelve una devolución), el motivo si lo hay, **quién** lo realizó y cuándo. Un movimiento hecho por una persona muestra a esa persona; uno hecho automáticamente (por
ejemplo, por una cuenta de servicio) aparece como **Sistema**.
