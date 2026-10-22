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

Abre una aplicación y elige **Otorgar acceso** arriba de la página. Eliges:

- **Usuario** — la persona que obtiene el acceso. Debe ser un usuario activo.
- **Nivel de acceso** *(opcional)* — una etiqueta de formato libre como `admin`, `developer` o
  `viewer`. lazyit la guarda tal cual y nunca la interpreta; escribe el nombre que la propia
  aplicación da a sus roles.
- **Vence** *(opcional)* — una fecha tras la cual la concesión se revoca automáticamente. Ver
  "Vencimiento" más abajo.
- **Notas** *(opcional)* — contexto, p. ej. "solicitado para la migración del Q3".

Otorgar (y revocar) acceso es una acción solo de administrador de forma predeterminada.

Solo puedes otorgar acceso a una persona **activa** con cuenta para iniciar sesión. lazyit rechaza
una concesión para alguien desactivado (reactívalo antes) o para una persona solo de directorio.

> Hoy el acceso se **otorga directamente** — no hay cola de aprobación. Está planificado un flujo
> formal de solicitud y aprobación; ver [Solicitudes de acceso](/help/applications-access-requests).

## Una persona, varias concesiones

Un usuario puede tener **más de una concesión activa** sobre la misma aplicación — por ejemplo
`admin` en la consola y `readonly` en la API. lazyit no las fusiona ni las deduplica; cada
concesión es su propio registro con su nivel, vencimiento y notas. Cuando otorgas acceso a alguien
que ya tiene alguno, el cuadro de diálogo muestra lo que ya posee para que decidas con intención.

## Editar una concesión

Desde la pestaña **Accesos** de una aplicación, abre el menú **⋯** de una concesión y elige
**Editar vencimiento y notas** para cambiar su **vencimiento** o sus **notas**. La concesión en sí — quién, qué aplicación y el nivel
de acceso — es intencionalmente fija. Para cambiar el **nivel de acceso**, revoca la concesión y
crea una nueva; así el historial mantiene la verdad sobre qué se tuvo y cuándo. El vencimiento no
puede ser anterior a la fecha en que se otorgó la concesión.

## Revocar acceso

**Revocar** (en el menú **⋯** de la concesión) finaliza una concesión. Esta es la acción de baja: la
concesión deja de estar activa, pero el registro permanece en **Revocados**, en la pestaña
**Accesos** de la aplicación, mostrando quién tuvo acceso,
quién lo otorgó, quién lo revocó y cuándo. Revocar **no** es eliminar — no hay forma de borrar una
concesión, por diseño.

## Vencimiento

Cuando una concesión pasa su fecha de vencimiento, lazyit la **revoca automáticamente** — un
barrido en segundo plano se ejecuta periódicamente y revoca cualquier concesión activa cuyo
vencimiento ya quedó en el pasado. La revocación automática pasa por el flujo normal de revocación,
así que queda en **Revocados**, en la pestaña **Accesos** de la aplicación, y dispara cualquier flujo de desaprovisionamiento
igual que una revocación manual; se registra como una revocación automática (del sistema) en lugar
de atribuirse a una persona. Hay una ventana breve entre el momento en que una concesión vence y el
siguiente barrido, durante la cual aún cuenta como activa y se marca como **Vencido**. **Borra el
vencimiento** para hacer una concesión permanente — dejar un vencimiento ahora significa que la
concesión será revocada.

## Dónde aparece el acceso

- En cada **aplicación**, la pestaña **Accesos** lista todas las concesiones. Encima del listado
  eliges qué ver: **Activos** (lo predeterminado), **Por vencer** (concesiones activas que vencen en
  los próximos 30 días, más las vencidas que el barrido todavía no revocó, lo más urgente primero),
  **Revocados** (lo más reciente primero) o **Todos**. Cada opción muestra su cantidad, sobre todas
  las concesiones de la aplicación.
- Cada fila muestra la persona y su email, el **nivel de acceso**, cuándo se otorgó y quién lo hizo,
  y su **vencimiento** — marcado *en N días* cuando está cerca, o **Vencido** — o, en una concesión
  revocada, cuándo y quién la revocó. Las notas aparecen debajo de la persona.
- Una persona con concesión que luego fue dada de baja queda señalada como **Desactivado** en sus
  concesiones, y la fila *Requiere atención* de la página cuenta las personas dadas de baja que todavía
  tienen acceso, para que encuentres rápido el acceso que debería limpiarse. Ese conteo se muestra solo
  a quienes pueden ver el directorio de usuarios.
- La pestaña **Actividad** de la aplicación lista cada otorgamiento y revocación con quién lo hizo,
  lo más reciente primero (de forma predeterminada, solo administradores).
- Para una revisión de accesos, **Exportar CSV** en la pestaña **Accesos** descarga exactamente lo
  que muestra la pestaña: la vista elegida (**Activos**, **Por vencer**, **Revocados** o **Todos**),
  acotada por el filtro de nivel y la búsqueda de personas, con todas sus páginas. La pestaña
  **Accesos** de una persona tiene el mismo botón para sus concesiones. Mira [Exportar datos](/help/notifications-activity-data-export).

## Buscar una concesión

La pestaña **Accesos** está pensada para aplicaciones con miles de concesiones: lazyit filtra y pagina
el listado por ti, así que sigue siendo rápida tenga las concesiones que tenga. Escribe en el cuadro de
búsqueda para encontrar a una persona **por nombre o email**. No importan las mayúsculas, pero sí los
acentos: escribe el nombre como está escrito, así `José` encuentra a José y `jose` no. Si escribes
varias palabras deben coincidir todas, así `ana ruiz` acota a las personas llamadas Ana Ruiz. Usa
el filtro de nivel para mostrar un solo **nivel de acceso** — por ejemplo, todos los que tienen `admin`
— o las concesiones registradas **Sin nivel**. El listado se ordena por persona, así que alguien con
varias concesiones aparece en filas seguidas, una por concesión, cada una con su propio **Editar** y
**Revocar**. Muestra 25 filas por página; el conteo debajo del listado dice cuántas coinciden.

La vista, el nivel, la búsqueda y la página quedan en la dirección de la página, así que puedes
guardar una vista filtrada en favoritos o enviársela a un compañero.

El cuadro de búsqueda aparece solo para quienes pueden ver el directorio de usuarios, porque busca en
los nombres y emails de las personas.

> Ver el mapa de acceso — quién tiene acceso a qué — está disponible para administradores y
> miembros. Los visualizadores no ven el registro de acceso de forma predeterminada.
