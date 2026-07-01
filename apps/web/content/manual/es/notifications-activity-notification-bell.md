---
title: Campana de notificaciones
order: 1
category: notifications-activity
subcategory: notification-bell
---

# Campana de notificaciones

La campana de la barra superior es la superficie de avisos dentro de la app: un conjunto pequeño y
seleccionado de eventos del tipo "alguien debería echarle un vistazo a esto". **No** es el registro de
auditoría — eso vive en el historial de actividad y en los libros mayores. La campana puede olvidar; el
historial no.

## Quién ve la campana

La campana aparece para **todas las personas con sesión iniciada**, pero lo que cada una ve está
acotado:

- **Notificaciones de difusión** — los avisos operativos de todo el parque (un acceso a una aplicación
  crítica, una elevación a administrador, stock bajo, un flujo de trabajo que necesita una persona o
  que falló, un otorgamiento de permiso sensible, un agente sin conexión) solo son visibles para quienes
  tengan el permiso de notificaciones en su rol. Por defecto, eso es **solo administradores**.
- **Notificaciones dirigidas** — una notificación dirigida a una persona concreta aparece en **su
  propia** campana, aunque no sea administrador ni tenga el permiso de notificaciones. Hoy la única
  notificación dirigida es el **aviso para configurar el almacén** (más abajo).

Así, una persona que no es administrador y no tiene nada dirigido a ella simplemente ve una campana
limpia y sin indicador; un administrador ve el feed de difusión más lo que esté dirigido a él.

## Qué dispara una notificación

El conjunto de disparadores es fijo y deliberadamente pequeño — la campana es un aviso seleccionado, no
una manguera:

| Notificación | Se dispara cuando |
| --- | --- |
| **Acceso a app crítica** | Un acceso abrió la puerta a una aplicación marcada como crítica. |
| **Administrador otorgado** | Un acceso o cambio de rol elevó a alguien al rol de Administrador. |
| **Stock bajo** | Un consumible pasó de estar por encima de su stock mínimo a estar en él o por debajo. |
| **Tarea manual** | Una ejecución de flujo de trabajo se pausó y espera que una persona actúe. |
| **Ejecución fallida** | Una ejecución de flujo de trabajo falló o escaló y se detuvo. |
| **Permiso sensible otorgado** | Una edición de permisos le dio al rol Miembro o Espectador una capacidad de alto riesgo — ajustes de la instancia, gestión de usuarios, control de accesos, o cualquier permiso de eliminación. Enlaza al editor de permisos por rol. |
| **Agente sin conexión** | Un agente de reportes dejó de enviar informes y su nodo pasó a estar sin conexión. Una notificación por caída — no una por cada chequeo. Enlaza al mapa de topología. |
| **Configurar almacén** | (Dirigida, una sola vez) A quien puede leer secretos pero nunca configuró una contraseña de almacén se le avisa al iniciar sesión para que configure una. |

Las notificaciones se emiten **después** de que la acción que las origina se completa, y son **de mejor
esfuerzo**: una notificación que no se logra enviar nunca bloquea ni deshace el cambio subyacente. Los
disparos repetidos del mismo evento se agrupan en una sola notificación, así que un consumible que
oscila alrededor de su umbral no inunda la campana.

## Leer y limpiar

Abre la campana para ver las notificaciones más recientes, las más nuevas primero. Cada fila lleva un
icono, un título corto, un resumen opcional de una línea y una hora relativa.

- **Haz clic en una fila** para abrir aquello de lo que trata — la aplicación, el consumible o la
  bandeja de tareas del flujo de trabajo — y la fila queda marcada como leída.
- **Marcar todo como leído** limpia el indicador de no leídas en un clic.
- El **indicador rojo** cuenta las notificaciones sin leer; muestra `99+` cuando pasan de noventa y
  nueve.

El estado de lectura es por persona: marcar como leída una difusión la limpia solo para ti, no para los
demás administradores.

## Qué contiene una notificación

El texto de una notificación es corto y está **redactado a propósito** — lleva solo nombres e
identificadores, nunca el contenido de los registros, secretos ni datos personales sensibles. El aviso
para configurar el almacén, en particular, no lleva material de claves: solo indica que no se ha
configurado una contraseña de almacén y enlaza al Gestor de Secretos.

## Retención

La campana conserva las notificaciones durante **90 días** y luego poda las antiguas automáticamente.
Es intencional: la campana es una superficie de avisos operativos, así que puede olvidar. El registro
duradero de quién hizo qué vive en el
[historial de actividad e informes](/help/notifications-activity-activity-reports), que no se poda de
esta forma.

## Entrega

En la versión actual la campana **sondea** en busca de notificaciones nuevas, por lo que hay un breve
retraso antes de que un evento nuevo aparezca. El envío en vivo es una mejora prevista detrás de la
misma superficie; nada de cómo usas la campana cambia cuando llegue.

## Dar la campana a otros roles

El feed de difusión es solo para administradores por defecto porque expone estado operativo sensible
(quién recibió acceso a una app crítica, a quién se hizo administrador). Un administrador puede otorgar
el permiso de notificaciones al rol Miembro o Visor desde los ajustes de permisos por rol si quiere que
esos roles vean el feed de difusión. Consulta [Permisos](/help/permissions) para ajustar qué puede
hacer cada rol.
