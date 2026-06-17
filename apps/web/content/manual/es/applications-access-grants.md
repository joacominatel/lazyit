---
title: Concesiones de acceso
order: 2
category: applications-access
subcategory: access-grants
---

# Concesiones de acceso

Una **concesión de acceso** registra que una persona tiene acceso a una aplicación — la respuesta
a "**¿quién puede acceder a qué?**". Las concesiones se conservan como un historial de solo
adición: nunca se eliminan, de modo que otorgar y (lo que es igual de importante) revocar el
acceso siempre es auditable. Esto es lo que hace confiables las revisiones de baja de personal.

## Otorgar acceso

Abre una aplicación y, bajo **Acceso activo**, elige **Otorgar acceso**. Eliges:

- **Usuario** — la persona que obtiene el acceso. Debe ser un usuario activo.
- **Nivel de acceso** *(opcional)* — una etiqueta de formato libre como `admin`, `developer` o
  `viewer`. lazyit la guarda tal cual y nunca la interpreta; escribe el nombre que la propia
  aplicación da a sus roles.
- **Vence** *(opcional)* — una fecha informativa. Ver "Vencimiento" más abajo.
- **Notas** *(opcional)* — contexto, p. ej. "solicitado para la migración del Q3".

Otorgar (y revocar) acceso es una acción solo de administrador de forma predeterminada.

> Hoy el acceso se **otorga directamente** — no hay cola de aprobación. Está planificado un flujo
> formal de solicitud y aprobación; ver [Solicitudes de acceso](/help/applications-access-access-requests).

## Una persona, varias concesiones

Un usuario puede tener **más de una concesión activa** sobre la misma aplicación — por ejemplo
`admin` en la consola y `readonly` en la API. lazyit no las fusiona ni las deduplica; cada
concesión es su propio registro con su nivel, vencimiento y notas. Cuando otorgas acceso a alguien
que ya tiene alguno, el cuadro de diálogo muestra lo que ya posee para que decidas con intención.

## Editar una concesión

Desde el listado de **Acceso activo** de una aplicación puedes **editar** una concesión para
cambiar su **vencimiento** o sus **notas**. La concesión en sí — quién, qué aplicación y el nivel
de acceso — es intencionalmente fija. Para cambiar el **nivel de acceso**, revoca la concesión y
crea una nueva; así el historial mantiene la verdad sobre qué se tuvo y cuándo.

## Revocar acceso

**Revocar** finaliza una concesión. Esta es la acción de baja: la concesión deja de estar activa,
pero el registro permanece en el **Historial** de la aplicación, mostrando quién tuvo acceso,
quién lo otorgó, quién lo revocó y cuándo. Revocar **no** es eliminar — no hay forma de borrar una
concesión, por diseño.

## Vencimiento

Una fecha de vencimiento es **solo informativa**. lazyit **no** revoca automáticamente una
concesión cuando pasa su vencimiento — una concesión vencida pero no revocada sigue siendo acceso
activo. lazyit la marca como **Vencido** para que la detectes y la revoques tú. Borra el
vencimiento para hacer una concesión permanente. (La revocación automática al vencer es una mejora
planificada, no el comportamiento actual.)

## Dónde aparece el acceso

- En cada **aplicación**, el panel de **Acceso activo** lista las concesiones vigentes y el panel
  de **Historial** muestra las revocadas.
- Una persona con concesión que luego fue desactivada queda señalada en sus concesiones, para que
  encuentres rápido el acceso que debería limpiarse.

> Ver el mapa de acceso — quién tiene acceso a qué — está disponible para administradores y
> miembros. Los visualizadores no ven el registro de acceso de forma predeterminada.
