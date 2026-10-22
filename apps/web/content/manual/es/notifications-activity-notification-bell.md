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
  que falló, un otorgamiento de permiso sensible, un agente sin conexión, una garantía de activo o una
  concesión de acceso por vencer) solo son visibles para quienes tengan el permiso de notificaciones en
  su rol. Por defecto, eso es **solo administradores**.
- **Notificaciones dirigidas** — una notificación dirigida a una persona concreta aparece en **su
  propia** campana, aunque no sea administrador ni tenga el permiso de notificaciones. Incluyen el
  **aviso para configurar el almacén** y la **decisión de una solicitud de acceso**, que le avisa a quien
  solicitó si su solicitud fue aprobada o rechazada (más abajo).

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
| **Agente sin conexión** | Un agente de reportes dejó de enviar informes y su nodo pasó a estar sin conexión. Una notificación por caída — no una por cada chequeo. No se envía por un silencio que solo duró mientras lazyit mismo estaba caído: cuando lazyit arranca, cada host tiene su espera completa para volver a informar antes. Nunca se envía por un servidor **retirado**, ni por uno con las alertas de desconexión **en pausa** (ver [Agente de reporte](/help/assets-topology-reporting-agent)). Enlaza al mapa de topología. |
| **Machine ID duplicado** | Dos servidores reportaron el mismo machine ID pero hardware distinto (un número de serie distinto *y* placas de red distintas): casi siempre una plantilla de VM o imagen dorada clonada con uno adentro. Los dos quedan listados por separado (no se unifica nada) y la notificación nombra la solución. Una notificación por host en conflicto, no una por cada reporte. Enlaza al mapa de topología. |
| **Configurar almacén** | (Dirigida, una sola vez) A quien puede leer secretos pero nunca configuró una contraseña de almacén se le avisa al iniciar sesión para que configure una. |
| **Solicitud de acceso resuelta** | (Dirigida) Tu propia solicitud de acceso fue aprobada o rechazada. Aparece en tu campana —y en tu correo, salvo que lo desactives— para que no tengas que revisar tu lista de solicitudes. Enlaza a la aplicación. |
| **Garantía por vencer** | La garantía de un activo está dentro de su ventana de anticipación (los últimos 90 días antes de terminar) y todavía no venció. Un aviso por activo, para que puedas renovar o reemplazar antes de la fecha límite en lugar de enterarte después. Enlaza al activo. |
| **Acceso por vencer** | Una concesión de acceso activa está a menos de dos semanas de su fecha de vencimiento y se revocará automáticamente cuando pase. Un aviso por concesión para que puedas volver a otorgar el acceso antes de que un contratista o temporal lo pierda en silencio. Enlaza a la aplicación. |
| **Recepción confirmada** | (Dirigida) Alguien confirmó la recepción de un activo que le asignaste. Llega a tu campana — y a tu correo, salvo que lo desactives — para que sepas que la entrega se completó sin tener que preguntar. Enlaza al activo. |
| **Nuevo agente de IA conectado** | (Dirigida, de seguridad) Un agente de IA externo —Claude Code, Cursor u otro cliente MCP, o un token MCP personal— se usó en tu cuenta por primera vez. Una por conexión. Aparece en tu campana —y en tu correo, salvo que lo desactives—. Si no fuiste tú, revoca la conexión en tus conexiones de IA y cambia tu contraseña. |

Las notificaciones se emiten **después** de que la acción que las origina se completa, y son **de mejor
esfuerzo**: una notificación que no se logra enviar nunca bloquea ni deshace el cambio subyacente. Los
disparos repetidos del mismo evento se agrupan en una sola notificación, así que un consumible que
oscila alrededor de su umbral no inunda la campana.

## Leer notificaciones

Abre la campana para ver tus notificaciones, las más nuevas primero. Cada fila lleva un icono, un
título corto, un resumen opcional de una línea y una hora relativa.

- **Haz clic en una fila** para abrir aquello de lo que trata — la aplicación, el consumible o la
  bandeja de tareas del flujo de trabajo — y la fila queda marcada como leída.
- **Marcar todo como leído** limpia el indicador de no leídas en un clic.
- El **indicador rojo** cuenta las notificaciones sin leer; muestra `99+` cuando pasan de noventa y
  nueve. Los lectores de pantalla siguen anunciando el número exacto.

### Agrupadas por tipo y día

Una operación masiva — una importación, un lote grande de accesos, una baja de personal — puede generar
cientos de notificaciones del mismo tipo en un día. Por eso la campana agrupa las notificaciones **por
tipo y día**: todo lo de un mismo tipo que ocurrió en un mismo día es una sola fila, por ejemplo «312
accesos a aplicaciones críticas · Hoy».

- Un grupo con **una** notificación se muestra como esa notificación, igual que arriba.
- Un grupo más grande muestra cuántas notificaciones contiene, el día (**Hoy**, **Ayer** o la fecha),
  cuántas siguen sin leer y una vista previa de las más recientes.
- **Selecciona el grupo** para desplegarlo ahí mismo y ver cada notificación; vuelve a seleccionarlo
  para plegarlo. En los grupos largos, **Cargar más** trae las siguientes cuando las pides.
- **Marcar grupo como leído** marca como leídas todas las notificaciones de ese grupo de una vez,
  incluidas las que todavía no se cargaron. Los demás grupos no cambian.

Los días siguen la zona horaria de visualización de la instancia (consulta
[Zona horaria y formatos](/help/configuration-time-zone-formats)), así que «Hoy» es hoy donde trabaja tu
equipo. Cuando hay más grupos de los que caben, **Cargar más** al final de la campana trae los
siguientes; la campana mantiene una altura fija y se desplaza por dentro.

El estado de lectura es por persona: marcar como leída una difusión la limpia solo para ti, no para los
demás administradores.

## Descartar notificaciones

Cuando ya te ocupaste de una notificación, puedes quitarla de tu campana en lugar de esperar a que
caduque:

- **Descartar una** — pasa el cursor sobre una notificación y selecciona la **×** de su borde derecho.
  Dentro de un grupo desplegado, cada notificación tiene su propia **×**. En un
  teléfono o una tableta la × se muestra siempre; con el teclado, llega a ella con Tab. Descartar no abre
  la notificación.
- **Descartar todas** — en la cabecera de la campana, quita de una vez todas las notificaciones hasta la
  más reciente que se muestra, incluidas todas las de cada grupo y las más antiguas que la campana no
  llega a cargar. Lo más reciente se queda: una notificación que llegó después de abrir la campana no se
  descarta y sigue sin leer. Cuando la campana queda vacía muestra «Estás al día.»

Descartar también marca la notificación como leída, así que el indicador baja con ella. Una notificación
que llega después de seleccionar **Descartar todas** aparece con normalidad.

Descartar es **por persona**, igual que el estado de lectura. Oculta la notificación solo de **tu**
campana: el evento en sí no se borra, y los demás administradores que ven la misma difusión la siguen
teniendo en sus campanas. El registro duradero del historial de actividad no se toca.

> [!IMPORTANT]
> Ninguna de las dos acciones pide confirmación, **no se puede deshacer** y no hay una vista de
> notificaciones descartadas. Una vez descartada, una notificación queda fuera de tu campana hasta que
> se pode con las demás a los 90 días. Descarta lo que
> ya resolviste; deja lo que todavía tengas que atender.

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
