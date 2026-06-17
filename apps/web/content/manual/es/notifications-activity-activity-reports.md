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
- **Responsable** — acota a las acciones de una persona (fijado en ti en la pestaña Mi historial).
- **Acción** — acota a un único tipo de acción.
- **Rango de fechas** — un preajuste rápido (Hoy, Últimos 7 días, Últimos 30 días) o un rango exacto
  desde/hasta.
- **Buscar** — coincidencia de texto libre sobre las entradas visibles.

Una fila de fichas de filtros activos muestra lo que está aplicado; quítalas una a una o todas a la vez.

## Vistas y exportación

- **Cronología** — una vista cómoda, agrupada por día; usa **Cargar más** para avanzar.
- **Tabla** — una tabla densa con paginación real de anterior/siguiente.
- **Exportar eventos visibles** — descarga las filas mostradas actualmente como CSV.
- **Imprimir** — imprime la vista actual.

Ambas acciones de exportación operan exactamente sobre lo que está visible en ese momento (los filtros y
la vista activos), así que acota el feed primero para exportar solo la porción que necesitas.

## Informes frente a la campana de notificaciones

Son superficies distintas para tareas distintas:

- La [campana de notificaciones](/help/notifications-activity-notification-bell) es un conjunto pequeño y
  seleccionado de avisos, conservado durante 90 días, mostrado a los administradores (más lo que esté
  dirigido a ti).
- Informes es el historial de actividad completo, que no se poda como la campana, y es el sistema de
  registro de quién hizo qué en todo el parque.
