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
"tomé uno / devolví uno" sin completar un formulario.

## El formulario detallado (ser específico)

En la página de detalle de un consumible, los botones **Agregar…**, **Quitar…** y **Ajustar…** abren
un diálogo donde eliges:

- una **cantidad** (un número entero, 1 o más),
- y, de forma opcional, un **Motivo** (una línea corta, por ejemplo *reposición*, *entregado a Ada*)
  y **Notas**.

En **Quitar**, el diálogo te avisa en línea si la cantidad supera lo disponible; el conteo se aplica
de todos modos al enviar. En **Ajustar**, el campo de cantidad pasa a ser un **nuevo conteo de
stock** —el número que contaste de verdad en el estante— y lazyit fija lo disponible exactamente en
ese valor.

## El registro es permanente

Los movimientos son **inmutables**: una vez registrado, un movimiento no se edita ni se elimina. Si
algo salió mal, lo corriges registrando otro movimiento: una **Entrada**/**Salida** contraria, o un
**Ajuste** al conteo correcto. Esto es intencional: el historial del stock de un consumible se
mantiene honesto y auditable.

El panel **Movimientos** de la página de detalle lista cada movimiento del más nuevo al más antiguo,
mostrando su tipo, la cantidad con signo (`+`, `−` o `=`), el motivo si lo hay, **quién** lo realizó
y cuándo. Un movimiento hecho por una persona muestra a esa persona; uno hecho automáticamente (por
ejemplo, por una cuenta de servicio) aparece como **Sistema**.
