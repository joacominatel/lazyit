---
title: Solicitudes de acceso
order: 4
category: applications-access
subcategory: access-requests
---

# Solicitudes de acceso

Una **solicitud de acceso** permite que una persona pida acceso a una aplicación en lugar de esperar a
que un administrador se lo otorgue directamente. La solicitud pasa por un flujo de aprobación breve:
**solicitada → aprobada o rechazada**. Al aprobarse produce un [acceso](/help/applications-access-grants)
común y corriente —el mismo registro que se crea cuando un administrador otorga acceso a mano—, así que
no cambia nada en cómo se lleva el registro del acceso.

Cualquiera puede solicitar acceso, incluidos los usuarios de solo lectura. Decidir sobre una solicitud
es una capacidad de administrador (las mismas personas que pueden otorgar acceso).

## Cómo solicitar acceso

1. Abrí la aplicación desde **Aplicaciones** y entrá a su página de detalle.
2. Arriba de la página, hacé clic en **Solicitar acceso**. (Si ya tenés acceso, o ya tenés una
   solicitud esperando una decisión, el botón se reemplaza por *Tienes acceso* o *Acceso solicitado*.)
3. Opcionalmente agregá:
   - un **nivel de acceso** —el tipo de acceso que necesitás, si la aplicación los distingue—; y
   - una **justificación** —una nota breve para que quien apruebe entienda por qué lo necesitás—.
4. Hacé clic en **Enviar solicitud**. Se notifica a los administradores y tu solicitud aparece en la
   cola de revisión.

Solo podés tener **una solicitud pendiente por aplicación** a la vez. Si ya tenés una, lazyit te lo
avisa en lugar de crear una duplicada.

## Qué pasa después

- Los administradores ven tu solicitud en **Acceso → Solicitudes de acceso** y reciben una notificación
  en la campana.
- Quien aprueba la **aprueba** —lo que crea tu acceso de inmediato— o la **rechaza** con un motivo.
- Cuando se toma una decisión recibís una **notificación** en tu propia campana —y un correo, salvo que
  hayas desactivado ese tipo en las [preferencias de correo](/help/notifications-activity-email-preferences)—
  que te dice si fue aprobada o rechazada (un rechazo incluye el motivo).
- La aprobación y el rechazo son definitivos para esa solicitud. Si una solicitud fue rechazada y
  todavía necesitás acceso, podés crear una nueva.

## Cargar una solicitud para otra persona

Quienes pueden aprobar solicitudes también pueden cargar una **en nombre de otra persona** —el caso de
mesa de ayuda, cuando un colega te lo pide en persona y querés que la solicitud quede registrada—. Solo
quienes tienen el permiso **Otorgar y revocar acceso** ven esta opción.

- En la página de una aplicación, hacé clic en **Solicitar para alguien**; o, desde **Acceso →
  Solicitudes de acceso**, hacé clic en **Cargar una solicitud** y elegí la aplicación.
- Elegí a la persona en **En nombre de**. Dejalo vacío para pedir acceso para vos. La persona tiene
  que estar **activa y tener una cuenta de acceso** —las personas solo de directorio y las dadas de baja
  no se pueden elegir, y lazyit rechaza la solicitud si lo son—.
- La regla de una solicitud pendiente se aplica a esa persona: si ya tiene una esperando para esta
  aplicación, lazyit te lo avisa en lugar de crear una duplicada.

Después la solicitud sigue el flujo de aprobación normal. Registra **quién la cargó**: la cola, la
pestaña **Solicitudes** de la aplicación y el perfil de la persona muestran **Cargada por**, y la
exportación CSV tiene una columna **Filed by**. La notificación de la decisión le llega a la persona
para la que es la solicitud, no a quien la cargó.

## Revisar solicitudes (administradores)

Abrí **Acceso → Solicitudes de acceso** para ver todo lo que espera una decisión. Cada fila muestra
quién pide, qué aplicación, el nivel solicitado, la justificación (si hay), cuándo se creó y, si se
cargó en nombre de alguien, quién la cargó.

- **Aprobar** otorga el acceso en el acto —sin formulario adicional—. El nuevo acceso se comporta
  exactamente como uno creado a mano (ejecuta cualquier flujo de acceso y queda registrado en el
  historial de acceso de la aplicación).
- **Rechazar** pide un **motivo**, que es obligatorio. El motivo se muestra a quien solicitó, para que
  sepa por qué.
- Si la persona fue **desactivada o dada de baja** después de cargar la solicitud, lazyit se niega a
  aprobarla y la solicitud sigue pendiente. Recházala con un motivo, o reactiva antes a la persona si
  debe recibir el acceso.

Revisar la cola requiere el permiso de lectura de solicitudes de acceso; aprobar o rechazar requiere el
mismo permiso que otorgar acceso. Ver [Roles y permisos](/help/permissions).

**Exportar CSV**, sobre la cola, descarga todas las solicitudes pendientes — mira [Exportar datos](/help/notifications-activity-data-export).

La página de cada aplicación también tiene una pestaña **Solicitudes** con solo las solicitudes de esa
aplicación: primero las **Pendientes**, después las **Aprobadas** y **Denegadas**, cada una con quién
decidió y cuándo (y el motivo, si se denegó). Las pendientes se pueden aprobar o denegar ahí mismo, y
su **Exportar CSV** descarga las solicitudes del estado seleccionado.

## Seguir tus solicitudes

Abrí tu **Perfil** para ver **Mis solicitudes de acceso** —cada solicitud que creaste y su estado
actual (**Pendiente**, **Aprobada** o **Rechazada**)—. Una solicitud rechazada muestra el motivo que
dio quien aprobó, y una que cargó un aprobador para vos lo indica. lazyit además te avisa en cuanto se toma una decisión —en tu campana y por correo,
salvo que lo desactives—, así que esta lista es el historial completo, no la única forma de enterarte
del resultado.
