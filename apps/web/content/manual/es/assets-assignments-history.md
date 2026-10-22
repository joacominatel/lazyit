---
title: Asignaciones e historial
category: assets
subcategory: assignments-history
order: 1
---

# Asignaciones e historial

La pertenencia en lazyit **no** es un campo que sobrescribes — es un registro de quién tuvo un activo
y cuándo. Eso es lo que mantiene al activo como el registro principal: las personas rotan, los activos
permanecen y el rastro completo de pertenencia se conserva automáticamente. Los responsables se
gestionan desde la página de detalle del activo, en el panel **Responsables** de su columna lateral.

## Asignar un responsable

Abre un activo, ve a **Responsables** y elige **Asignar usuario**. Elige a la persona y agrega una nota
opcional (por ejemplo "notebook principal de trabajo"). El activo pasa a listar a esa persona como
**responsable activo**.

Algunas cosas a tener en cuenta:

- **Un activo puede tener varios responsables a la vez.** lazyit admite pertenencia compartida y
  simultánea — por ejemplo un servidor del que varias personas son responsables. Asignar un segundo
  responsable no desplaza al primero.
- **Una asignación activa por persona y activo.** No puedes asignar a la misma persona al mismo activo
  dos veces mientras la primera asignación siga activa — libérala primero.
- Solo puedes asignar un activo **vigente** a un usuario **vigente** — los activos y usuarios
  desactivados no pueden recibir nuevas asignaciones.

### Entregar un reemplazo: lo que la persona ya tiene

Un cambio habitual: le das a alguien una notebook nueva y recuperas la anterior. Para que el
inventario no termine diciendo que todavía tiene las dos, el paso de asignar muestra lo que la persona
**ya tiene**.

En cuanto eliges a la persona, se abre un panel **Tiene actualmente** junto al formulario (debajo, en
una pantalla angosta). Lista cada activo que tiene asignado ahora, salvo el que estás asignando, con su
etiqueta, modelo, estado y desde cuándo lo tiene. Cada nombre abre el activo en una pestaña nueva, así
no pierdes lo que ya completaste. Si no tiene nada más, el panel lo indica. Tener varios activos es
normal: el panel nunca advierte ni bloquea, solo te muestra la lista.

Para recuperar algo en el mismo paso, marca **Liberar** en esa fila. Puedes marcar varios y agregar
una **Nota de liberación** opcional que se guarda en cada activo que liberes (por ejemplo "devolvió la
notebook anterior"). Todavía no cambia nada:

- **Asignar** primero registra la nueva asignación y después libera cada activo marcado. Una
  liberación solo termina la asignación de esa persona, igual que **Liberar** en la página del activo;
  el estado y la ubicación del activo quedan como están.
- **Cancelar** (o cerrar la ventana) no cambia nada — las marcas simplemente se descartan. Elegir a
  otra persona también las borra.
- Si la nueva asignación falla, no se libera nada y tus marcas se conservan para que lo intentes de
  nuevo.
- Si la asignación funciona pero una liberación no, la ventana queda abierta con un resumen breve: cada
  activo marcado, indicado como **liberado** o **no liberado** con el motivo. Los que no se liberaron
  siguen asignados a la persona; libéralos desde la página del activo.

El mismo panel aparece en los tres lugares donde asignas un responsable: **Asignar usuario** en la
página de un activo, la acción rápida **Asignar** de la lista de activos y el responsable de **Ventaja
inicial** al crear un activo. En un activo nuevo, las liberaciones marcadas se aplican justo después de
crear y asignar el activo, y cualquier liberación que falle se lista en un aviso que queda visible hasta
que lo cierras.

Necesitas permiso para **ver el directorio de usuarios** para ver lo que alguien tiene; sin él, el
panel no aparece y asignar funciona como siempre. Si tu rol puede ver el directorio pero no puede
liberar activos, la lista se muestra sin las marcas de **Liberar**.

## Liberar un responsable

Para terminar la pertenencia de alguien, elige **Liberar** junto a ese responsable. Liberar a un
responsable no afecta a los demás. Puedes agregar una nota explicando el motivo (por ejemplo una
devolución o una entrega).

Liberar **no** borra la asignación — le pone una fecha de liberación y la mueve al historial de
pertenencia. Esto es deliberado: no hay una acción de "borrar asignación", porque el objetivo es
conservar el registro. Para pasar un activo de una persona a otra, **libera** al responsable anterior
y **asigna** al nuevo.

> Un responsable que dejó la empresa sigue figurando como responsable activo hasta que liberes
> explícitamente la asignación — lazyit nunca descarta registros de pertenencia en silencio.

**Quien puede ver los activos ve el nombre y el correo de cada responsable**, también los Lectores, en
la lista de activos, la página de un activo y su historial de pertenencia. Quién tiene un equipo, y cómo
contactarlo, es parte del registro del inventario. Es deliberado, y no equivale a recorrer el directorio
de usuarios, que sigue oculto para los Lectores por defecto. Las páginas de **Servidores** son la
excepción: allí el correo de un responsable aparece solo si tu rol puede ver el directorio de usuarios.

El nombre y el correo son **todo** lo que ve de un responsable un rol sin acceso al directorio de
usuarios. El resto de la ficha de la persona —su rol, número de legajo, nombre de usuario y datos del
directorio como el puesto o el área— sigue en el directorio de usuarios. Listar los activos que tiene
una persona concreta también requiere ese acceso, así que el filtro **Responsable** de la lista de
activos no se le ofrece a ese rol (un enlace compartido que lo incluya muestra la lista sin filtrar).
Cualquiera puede seguir viendo sus propios activos en **Mis activos**.

## Confirmar la recepción

Asignar un activo registra **quién es responsable** de él, pero no prueba que la persona realmente lo
recibió. **Confirmar recepción** cierra esa brecha: el propio responsable confirma que tomó posesión.

- **Autoservicio.** Solo el responsable puede confirmar **su propia** asignación activa. Abre el
  activo, ubícate en **Responsables** y elige **Confirmar recepción**. Puedes agregar una nota opcional
  (por ejemplo "recibido en buen estado"). Nadie puede confirmar en nombre de otra persona.
- **Una fecha confirmada.** Una vez confirmada, la línea del responsable muestra **Confirmado
  &lt;fecha&gt;** y el evento se escribe en el registro de actividad del activo. Hasta entonces dice
  **Pendiente de confirmación**, para que un operador vea de un vistazo qué entregas siguen sin
  confirmar.
- **Se notifica a quien asignó.** Cuando confirmas, quien te asignó el activo recibe una notificación
  (en su campana y por correo, salvo que lo haya desactivado) — una confirmación silenciosa y
  automática de que la entrega se completó.
- **Se hace una sola vez.** La confirmación es unidireccional: no se puede deshacer ni repetir, y una
  asignación ya confirmada o liberada no se puede volver a confirmar.

Es opcional — una asignación es válida se confirme o no — pero en entregas de activos donde importa la
responsabilidad, te da un registro claro de que la persona confirmó la recepción.

## Acciones rápidas desde la lista de activos

No hace falta abrir un activo para gestionar su responsable. Cada fila de la lista de **Activos** trae
una acción rápida con color:

- **Asignar** (azul) en una fila sin responsable — abre el mismo selector que la página de detalle.
- **Desasignar** (ámbar) en una fila que ya tiene uno — te pide confirmación y luego libera al
  responsable actual hacia el historial de pertenencia.

Cada fila tiene además un menú **…** con el resto: abrir el activo en una pestaña nueva, editarlo o
clonarlo, asignar o quitar su asignación, **cambiar estado** (un submenú rápido) y eliminarlo. Cambiar
el estado desde aquí es instantáneo y reversible — sin confirmación, igual que la acción masiva. Estos
atajos respetan tus permisos: solo ves las acciones que tienes permitido ejecutar.

## Actividad e historial de pertenencia

Cada activo lleva un **registro de actividad de solo adición** — una línea de tiempo de eventos
discretos, del más reciente al más antiguo. El registro es inmutable: las entradas se escriben, nunca
se editan ni se borran. Lo encuentras en la página de detalle del activo en la pestaña **Actividad**, con las
entradas específicas de pertenencia bajo **Historial de responsables** en la misma pestaña.

Los eventos registrados incluyen:

- **Creado** y **Eliminado** / **Restaurado** — el ciclo de vida del activo.
- Cambios de **Estado** — por ejemplo Operativo → En mantenimiento.
- Cambios de **Ubicación** y **Modelo**.
- Cambios de **Specs** — ediciones de los campos personalizados.
- **Actualizado** — ediciones de los demás datos del activo (nombre, serie, etiqueta, notas, empresa,
  fechas, costo); la entrada enumera qué campos se editaron — por ejemplo *Cambiaron: Nombre, Notas* —,
  nunca sus valores anteriores ni nuevos, y marca *por reimportación* una edición que vino de una
  reimportación. Las entradas registradas antes de esta lista dicen *Datos actualizados*. La edición
  también aparece en [Informes](/help/notifications-activity-activity-reports).
- **Asignado** y **Liberado** — cambios de pertenencia, nombrando al responsable involucrado.
- **Confirmado** — un responsable confirmó la recepción del activo entregado a él.
- **Consumible entregado** y **Consumible devuelto** — insumos colocados o dejados en el activo (un
  tóner en una impresora, un disco de repuesto en un servidor), con la cantidad y un enlace al
  consumible; y unidades de un ítem retornable que se devolvieron. Consulta
  [Movimientos de stock](/help/consumables-stock-movements).

Cada entrada registra **qué cambió, cuándo y quién lo hizo** (o "Sistema" cuando lazyit actuó por su
cuenta). Junto con el borrado lógico en todo el sistema, esto te da el rastro de auditoría de toda la
vida de un activo sin trabajo extra.

## Consumibles entregados al activo

La página de un activo tiene una sección **Consumibles entregados**: cada
consumible entregado a este activo, del más reciente al más antiguo, con la cantidad y la fecha. Un
ítem retornable muestra lo que sigue **pendiente** y ofrece **Devolver…**; **Entregar consumible**
registra una entrega nueva a este activo sin salir de la página. Ambas acciones requieren permiso para
registrar movimientos de stock. La sección no aparece si no puedes ver consumibles. Consulta
[Movimientos de stock](/help/consumables-stock-movements).

## Qué sigue

- [Conceptos de activos](/help/assets-asset-basics) — registra y edita activos.
- [Ubicaciones](/help/assets-locations) — controla dónde reside un activo.
