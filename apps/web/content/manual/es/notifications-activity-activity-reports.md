---
title: Actividad e informes
order: 1
category: notifications-activity
subcategory: activity-reports
---

# Actividad e informes

**Informes** es el historial de actividad de todo el parque: un único flujo cronológico de quién hizo
qué en activos, accesos a aplicaciones, stock y usuarios. Donde la campana de notificaciones te avisa de
un puñado de eventos seleccionados, Informes es el registro duradero y filtrable al que acudes cuando
necesitas responder "qué pasó, y quién lo hizo".

## Quién puede verlo

Informes es **solo para administradores por defecto**, protegido por el permiso de historial de
actividad. Si tu rol no lo tiene, la página de Informes muestra un mensaje de acceso denegado tranquilo
en lugar del feed, y el enlace **Informes** se oculta de la navegación. El mismo permiso protege el feed
de actividad reciente del panel. Un administrador puede otorgar el permiso al rol Miembro o Visor desde
los ajustes de permisos por rol — consulta [Permisos](/help/permissions).

## Qué muestra

El feed combina en una sola cronología los eventos de todo el producto:

- **Activos** — historial y asignaciones (asignado / liberado).
- **Acceso** — accesos a aplicaciones otorgados y revocados.
- **Stock** — movimientos de consumibles (entrada / salida / ajuste).
- **Usuarios** — el ciclo de vida de las personas.

Cada entrada muestra cuándo ocurrió, la acción, la entidad que tocó, el **responsable** que la realizó
(o "Sistema" para los cambios automáticos) y un resumen de una línea. Haz clic en una entrada para abrir
el registro al que se refiere.

## Filtrar

Cada filtro acota el feed en el servidor, de modo que los totales y la paginación siempre reflejan el
resultado filtrado real — no una porción parcial. Los filtros se combinan, y todo el conjunto de filtros
se guarda en la URL de la página, así que una vista filtrada se puede compartir y sobrevive a la
navegación hacia atrás.

- **Pestañas de alcance** — **Todo**, **Activos**, **Acceso**, **Stock**, **Usuarios** y **Mi historial**
  (solo tus propias acciones).
- **Responsable** — acota a las acciones de una persona (fijado en ti en la pestaña Mi historial). La
  lista ofrece solo las personas que realmente han realizado alguna acción registrada, no todo el
  directorio.
- **Acción** — acota a un único tipo de acción. La lista ofrece solo los tipos de acción que realmente
  ocurrieron, así nunca eliges un filtro que no puede devolver nada.
- **Rango de fechas** — un preajuste rápido (Hoy, Últimos 7 días, Últimos 30 días) o un rango exacto
  desde/hasta.
- **Buscar** — coincidencia de texto libre sobre las entradas visibles.

Una fila de fichas de filtros activos muestra lo que está aplicado; quítalas una a una o todas a la vez.

## Tabla y exportación

El feed es una única **tabla** densa — cuándo, acción, entidad, responsable y un resumen de una línea, una
fila por evento. La paginación es real de anterior/siguiente sobre el resultado filtrado (eliges cuántas
filas por página), así que cada página es una porción real del recuento del servidor, nunca una ventana
parcial.

- **Exportar todo (filtrado)** — descarga un CSV con **todos** los eventos que coinciden con los filtros
  actuales — el rango completo, no solo la página que estás viendo. El archivo se transmite desde el
  servidor, así que funciona incluso con historiales grandes; el tamaño de página y la página en la que
  estás se ignoran.
- **Exportar eventos visibles** — descarga solo las filas mostradas actualmente (los filtros **y** la
  página actual) como CSV.
- **Imprimir** — imprime la vista actual.

Ambas exportaciones a CSV producen las mismas columnas (cuándo, acción, entidad, id de entidad,
responsable, resumen) y son seguras de abrir en una hoja de cálculo. La diferencia es el alcance:
**Exportar todo** es todo el historial filtrado, mientras que **Exportar eventos visibles** e **Imprimir**
operan solo sobre la página que tienes delante. Acota el feed con los filtros primero para exportar solo la
porción que necesitas.

## Informes frente a la campana de notificaciones

Son superficies distintas para tareas distintas:

- La [campana de notificaciones](/help/notifications-activity-notification-bell) es un conjunto pequeño y
  seleccionado de avisos, conservado durante 90 días, mostrado a los administradores (más lo que esté
  dirigido a ti).
- Informes es el historial de actividad completo, que no se poda como la campana, y es el sistema de
  registro de quién hizo qué en todo el parque.
