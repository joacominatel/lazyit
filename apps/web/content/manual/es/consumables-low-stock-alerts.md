---
title: Alertas de stock bajo
category: consumables
subcategory: low-stock-alerts
order: 3
---

# Alertas de stock bajo

Un consumible puede tener un **umbral de reposición**: el conteo a partir del cual quieres que se te
recuerde reponer. lazyit lo usa para marcar los ítems bajos en el listado y para generar una
notificación cuando un ítem cruza por debajo de la línea. Define el umbral en el formulario del
consumible (consulta [Consumibles y categorías](/help/consumables-consumables-categories)); es
opcional, y un consumible sin umbral nunca se marca como bajo.

## Qué significa "bajo"

Un ítem está en **stock bajo** cuando su conteo disponible está **en el umbral de reposición o por
debajo** (y tiene un umbral definido). Está **sin stock** en 0. En el listado, la cifra de stock se
pone **ámbar** cuando está baja y **roja** cuando se agota; el filtro **Solo stock bajo** reduce el
listado a los ítems que están en su umbral o por debajo, para que puedas armar una lista de compras
de un vistazo.

Definir un umbral no cambia ningún stock: solo decide cuándo un ítem cuenta como bajo.

## La notificación

Cuando un movimiento lleva a un consumible **de estar por encima de su umbral a estar en él o por
debajo**, lazyit genera una **notificación de stock bajo** en la campana de notificaciones de la
app. El aviso nombra el ítem y muestra cuántos quedan frente al mínimo, para que sepas qué reponer.

Dos detalles evitan que se vuelva ruido:

- **Solo en el cruce hacia abajo.** La alerta se dispara en el movimiento que *primero* deja el ítem
  en su umbral o por debajo. Un ítem que ya está bajo y sigue oscilando (sacar uno, devolver uno,
  mientras sigue bajo la línea) **no** vuelve a avisar.
- **Como mucho una vez al día por ítem.** Si un consumible vuelve a cruzar hacia abajo otro día,
  recibes un recordatorio nuevo; los cruces repetidos del *mismo* día se agrupan en uno.

La alerta es de **mejor esfuerzo**: nunca bloquea ni deshace el movimiento de stock en sí. Si por
algún motivo no se puede generar una notificación, el movimiento igual queda registrado; solo te
pierdes ese aviso puntual.

## Qué hacer al respecto

Una alerta de stock bajo es un recordatorio para reponer, no un pedido automático: lazyit no repone
por ti. Cuando llegue stock nuevo, registra un movimiento de **Entrada** (consulta
[Movimientos de stock](/help/consumables-stock-movements)), y una vez que el conteo disponible vuelva
a subir por encima del umbral, el ítem sale de la vista de stock bajo.
