---
title: Criticidad y alertas
order: 3
category: applications-access
subcategory: criticality-alerts
---

# Criticidad y alertas

Algunas aplicaciones importan más que otras. Marcar una aplicación como **Crítica** le indica a
lazyit que es especialmente sensible — infraestructura de producción, sistemas de finanzas,
cualquier cosa donde quieras vigilar más de cerca quién entra. La criticidad es una sola marca que
estableces en la aplicación, y cambia dos cosas: cómo se **muestra** la app y qué ocurre **cuando
se otorga acceso**.

## Marcar una aplicación como crítica

Al crear o editar una aplicación, activa **Crítica**. lazyit entonces:

- Muestra una insignia **Crítica** en la fila de la aplicación y en su página de detalle.
- Te permite **filtrar** el listado de Acceso a *solo críticas* (o *no críticas*), para que
  revises por separado tus sistemas más sensibles.
- Resalta el número de acceso activo en aplicaciones críticas para una revisión de un vistazo.

Crítica es puramente tu criterio — lazyit no lo decide por ti, y cambiarlo después es solo una
edición.

## Alertas cuando se otorga acceso crítico

El sentido de la marca es la visibilidad en el momento que importa. **Cuando se otorga a alguien
acceso a una aplicación crítica, lazyit genera una notificación** para que los administradores la
vean sin tener que ir a buscarla. La alerta nombra a la persona y a la aplicación, y se marca como
advertencia. Aparece en la campana de notificaciones de la app.

Una segunda alerta relacionada se dispara siempre que una concesión se da con un **nivel de
administrador** (un nivel de acceso `admin` o `administrator`) — incluso en una aplicación no
crítica — porque el acceso de nivel admin merece conocerse dondequiera que ocurra.

Estas alertas tratan de *conciencia*, no de aplicación de reglas: no bloquean la concesión ni
exigen aprobación. La concesión se hace de inmediato; la notificación solo asegura que las
personas adecuadas se enteren. Cada concesión genera su propia alerta, así que volver a otorgar
acceso más tarde se señala de nuevo.

> La campana de notificaciones y cómo leer y descartar alertas se explican en **Notificaciones y
> actividad** en esta Ayuda. Las alertas de criticidad son uno de los eventos seleccionados que
> llegan ahí.

## Lo que la criticidad no hace

- **No** restringe a quién se le puede otorgar acceso — eso lo deciden los permisos, no la marca.
- **No** revoca ni vence nada automáticamente.
- **No** cambia el comportamiento de una concesión; las concesiones de una app crítica funcionan
  exactamente igual que las de cualquier otra (ver [Concesiones de acceso](/help/applications-access-grants)).

Piensa en Crítica como un reflector: hace que las aplicaciones sensibles sean fáciles de encontrar
y que el nuevo acceso a ellas sea imposible de pasar por alto.
