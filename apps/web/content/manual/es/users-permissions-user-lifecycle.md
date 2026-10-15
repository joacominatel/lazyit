---
title: Ciclo de vida del usuario
category: users-permissions
subcategory: user-lifecycle
order: 5
---

# Ciclo de vida del usuario

Esta página cubre toda la vida de una persona en lazyit: crearla, darle un rol y un punto de partida,
clonar a un colega existente, restablecer una contraseña, darla de baja y restaurarla.
Todo esto vive en la sección de **Usuarios** y requiere la capacidad **Gestionar usuarios**
(administrador por defecto).

## Crear un usuario

Elige **Nuevo usuario** y completa la identidad de la persona:

- **Nombre y apellido**, y **Correo** — el correo debe ser único. Con tu propio proveedor OIDC es además
  la clave de vinculación: el primer inicio de sesión de la persona se vincula a este registro por
  correo verificado. Un cambio posterior se queda en lazyit y no se envía al proveedor.
- **Rol** — por defecto es solo lectura; defínelo aquí o cámbialo más tarde. Ver
  [Roles](/help/users-permissions-roles).
- **Número de empleado** y **Nombre de usuario** (ambos opcionales) — datos de directorio, únicos entre
  los usuarios activos. Cuando lazyit gestiona las contraseñas por su cuenta, el nombre de usuario **sí**
  es un identificador de inicio de sesión: la persona puede entrar con su nombre de usuario o con su
  correo. Detrás de un proveedor de identidad es solo un identificador de directorio, nunca una
  credencial.
- **Responsable** (opcional) — un usuario de lazyit existente **o** un nombre de texto libre, no ambos.

**Credencial de inicio de sesión.** Con **cuentas locales**, defines una **contraseña temporal** para
que la persona pueda iniciar sesión; deberá elegir la suya en el primer inicio, y se muestra una sola
vez para la entrega. lazyit la guarda solo como **hash** — nunca la contraseña que escribiste, así que
nadie, ni siquiera un administrador, puede volver a leerla. Perder la entrega no es un callejón sin
salida: restablece la contraseña (más abajo) en lugar de intentar consultarla. Con tu propio proveedor
OIDC este paso no aparece — crea a la persona en tu proveedor con el mismo correo y gestiona allí la
credencial.

**Punto de partida (opcional).** Puedes asignar un activo y conceder acceso a una aplicación desde el
mismo formulario de creación, para que la persona empiece con lo que necesita.

## La página de una persona

Al abrir un usuario ves su ficha, organizada como la página de un activo.

- **La tarjeta de resumen** arriba: nombre, estado, rol, y el correo (con un botón para copiarlo), el
  nombre de usuario y el legajo. Debajo, los **datos clave** cuentan los **activos en posesión**, el
  **acceso a aplicaciones** y los **artículos** que escribió; elige un contador para abrir su pestaña.
  Al lado figura su responsable.
- **Requiere atención**: aparecen avisos solo cuando hay algo que hacer: accesos que vencen en los
  próximos 30 días, accesos que ya vencieron y están por revocarse, y activos cuya recepción la persona
  todavía no confirmó.
- **Pestañas**: **Activos** (cada uno con su etiqueta, modelo, categoría, estado y si se confirmó la
  recepción), **Accesos** (primero los vencidos y los que vencen pronto), **Artículos**,
  **Consumibles** e **Historial**, una sola lista de los activos que devolvió y los accesos que perdió,
  del más reciente al más antiguo. Cada pestaña aparece solo para quienes pueden ver lo que contiene.
  La pestaña abierta queda en la dirección de la página, así un enlace compartido abre en la misma
  pestaña.
- **La columna lateral** tiene el **Perfil**: rol (editable con *Gestionar usuarios*), responsable,
  legajo, nombre de usuario, correo y fechas. Para una persona de directorio también explica cómo darle
  una cuenta de acceso.

El encabezado deja a mano **Restablecer contraseña** (solo con cuentas locales) y **Editar**. **Clonar**
y **Dar de baja** están en el menú **⋯** al lado, con Dar de baja separado para que no se elija por
error.

## Clonar un usuario

Para incorporar a alguien que replica a un colega ("el mismo acceso que Ana"), abre un usuario y elige
**Clonar** en el menú **⋯**. Eliges un correo nuevo y único y un rol, y luego seleccionas cuáles de los **activos** y del
**acceso a aplicaciones** del origen se trasladan.

Por defecto, el acceso clonado **solo se registra** — es contabilidad, sin efecto externo. Hay un
interruptor opcional para **aprovisionar al nuevo usuario en estas aplicaciones**, que ejecuta los
flujos de aprovisionamiento de las apps seleccionadas. Tras clonar, lazyit te indica qué se trasladó y
enumera lo que se omitió (y por qué). Un activo o una aplicación seleccionados que se hayan **eliminado**
desde entonces se omiten en lugar de copiarse, para que la clonación nunca reviva un activo retirado ni
una aplicación dada de baja.

## Restablecer una contraseña

En la página de detalle de un usuario, **Restablecer contraseña** inicia el restablecimiento de la
contraseña de esa persona. Solo existe con **cuentas locales**, donde lazyit gestiona las contraseñas.
Con tu propio proveedor OIDC la acción no aparece: la credencial es del proveedor, así que restablécela
allí.

Eliges cómo le llega el restablecimiento a la persona:

- **Enviar un enlace de restablecimiento por correo** — la persona recibe en su dirección un enlace de
  un solo uso y elige su propia contraseña; lazyit nunca la ve. La confirmación te indica exactamente a
  qué dirección se envió el enlace y cuánto tiempo sigue siendo válido. Esta opción necesita
  [correo saliente (SMTP)](/help/configuration-smtp-email) y una URL pública para tu instancia; si falta
  alguna de las dos, la opción aparece deshabilitada y lazyit te dice cuál corregir, en lugar de fingir
  que el correo salió. Bajo esta opción hay una casilla **Cerrar la sesión de este usuario en todas
  partes**, **desactivada por defecto** — un enlace no cambia la contraseña actual, así que las sesiones
  abiertas de la persona siguen siendo legítimamente suyas. Actívala cuando creas que la cuenta está
  comprometida.
- **Generar una contraseña temporal** — lazyit crea una contraseña de un solo uso y te la muestra **una
  sola vez**, para que la entregues tú. Es la salida cuando la persona no puede acceder a su correo, así
  que sigue disponible incluso cuando el correo funciona. Reemplaza su contraseña de inmediato y, por
  tanto, **siempre** cierra su sesión en todas partes; deberá elegir una contraseña nueva en su próximo
  inicio de sesión.

> [!IMPORTANT]
> Una contraseña temporal se muestra **una sola vez**. Cópiala antes de cerrar el diálogo — no se vuelve
> a mostrar ni se puede consultar más tarde. Si la pierdes, basta con repetir el restablecimiento.

La acción no está disponible para un usuario inactivo (reactívalo primero) ni para una persona de
directorio que todavía no tiene cuenta de inicio de sesión — en ese caso dale de alta con una contraseña
temporal, que le entrega la primera.

Si un restablecimiento falla — el correo no está configurado, el mensaje no se pudo enviar, la cuenta no
es elegible — lazyit lo dice con claridad y mantiene el diálogo abierto, para que puedas leer el motivo
y elegir la otra opción.

## Dar de baja a un usuario

Cuando alguien se va, ábrelo y elige **Dar de baja** en el menú **⋯**. Se abre un panel ancho con el
impacto completo de antemano: cuatro recuadros cuentan los **activos que se liberan**, los **accesos que se
revocan**, los **consumibles pendientes** y la **cuenta que se archiva** (su historial se conserva). Debajo,
la columna izquierda lista lo que pasa al confirmar — los activos a devolver, el acceso a aplicaciones a
revocar (con su nivel de acceso y una marca **Crítica** en las aplicaciones críticas) y los consumibles
entregados — y la columna derecha contiene el acta de entrega opcional. Al confirmar, lazyit:

- **revoca** el acceso activo a aplicaciones de la persona,
- **quita** el acceso de la persona a cada [bóveda de secretos](/help/secret-manager-vaults-members) a
  la que pertenecía (se elimina su membresía criptográfica),
- **libera** los activos que tiene,
- **archiva** al usuario (un borrado lógico) para que ya no se le puedan asignar activos.

Todo ocurre junto: si algún paso falla, la baja completa se revierte, de modo que una persona nunca queda
a medio dar de baja (archivada pero conservando acceso).

**Se cierra su sesión en todas partes.** En una instancia con **cuentas locales**, dar de baja termina las
sesiones de la persona en todos sus dispositivos a la vez — también aquella en la que marcó **Mantener la
sesión iniciada**. Desactivarla (desmarcar **Activo** al editarla) hace lo mismo.

**Con tu propio proveedor OIDC, desactívala también allí.** lazyit no toca la cuenta de la persona en tu
proveedor, pero sí rechaza su inicio de sesión en lazyit, haya entrado antes o no. Si nunca había
entrado, esto depende de que tu proveedor marque su correo como verificado. Para que vuelva a entrar,
[restáurala](#restaurar-un-usuario). Aun así, desactiva la cuenta en tu proveedor dentro del mismo proceso
de salida: es lo que le corta el acceso a todo lo demás a lo que tu proveedor le da entrada.

**Rota los secretos que pudo leer.** Si la persona era miembro de alguna bóveda de secretos, la
confirmación lista esas bóvedas (con cuántos secretos tiene cada una) como recordatorio para **rotar esos
secretos a mano**. Quitar su membresía detiene cualquier lectura *nueva*, pero como ya pudo leer esas
bóvedas, conviene cambiar los valores. lazyit **no puede rotarlos por ti** — es zero-knowledge y nunca ve
el texto plano, así que no puede volver a cifrarlos en tu nombre. Es un aviso, no una acción automática.
(Quién quitó el acceso a la bóveda de quién, y cuándo, queda registrado en la auditoría del Gestor de
Secretos.)

**Nada se destruye.** La persona y su historial se conservan para el registro — el pie del panel lo
recuerda, y el botón nombra a la persona que estás dando de baja. Dar de baja es válido incluso cuando la
persona no tiene nada — sigue valiendo como constancia de su salida.

**El acta de entrega.** La columna derecha muestra una vista previa en vivo del **acta de baja** impresa:
el nombre de la empresa y la fecha, la persona, las secciones que va a listar, tu nota de entrega y las dos
líneas de firma (Empleado y TI). Se actualiza a medida que cambias la configuración. Abre **Personalizar
acta** para fijar el nombre de la empresa, editar la nota de entrega (se guarda como plantilla y se completa
sola en cada acta) y elegir qué lista el acta con los chips **Activos**, **Accesos** y **Consumibles**. Esta
configuración se conserva para la próxima vez. Elige **Imprimir acta** para abrir el acta en una pestaña
nueva y firmarla en papel en la entrega.

Si el panel no puede cargar los activos, accesos o consumibles de la persona, lo indica en lugar de mostrar
listas vacías, los recuadros muestran "—" y el acta no se puede imprimir hasta que pulses **Reintentar** y
cargue.

**Los consumibles que recibió.** La hoja de baja también lista los
[consumibles entregados](/help/consumables-stock-movements) a la persona, en dos grupos:

- **Consumibles a devolver** — ítems retornables que siguen pendientes (unos auriculares en préstamo,
  un cargador de repuesto), con cuántas unidades siguen afuera. Es lo que hay que pedirle que devuelva.
- **Consumibles entregados** — ítems entregados para siempre (tóner, cables), listados como registro.

La baja **no mueve stock** ni cierra ninguna entrega: registra cada devolución desde la página de la
persona a medida que el ítem vuelve. Por defecto, todo lo listado se imprime en el acta de baja.
Desmarca una fila para dejarla fuera, o desactiva el chip **Consumibles** en **Personalizar acta** para
dejar fuera toda la sección; el acta imprime exactamente lo que conservaste. Si la persona recibió más de lo
que la hoja puede listar, indica cuántos más hay en lugar de omitirlos en silencio.

## Consumibles en la página de una persona

La página de una persona tiene una pestaña **Consumibles** con lo que se le entregó, del más
reciente al más antiguo. **Solo pendientes** muestra solo los ítems retornables que siguen afuera, y un
filtro de fechas la acota según cuándo se entregaron. Con permiso para registrar movimientos de stock
puedes **Entregar consumible** a esa persona o registrar una devolución con **Devolver…** desde aquí. Quienes no
pueden ver a otros usuarios no ven esta pestaña.

## Encontrar usuarios por rol

La lista de Usuarios tiene un **filtro de rol** junto a los filtros de estado y de directorio: elige
**Admin**, **Miembro** o **Lector** para mostrar solo a quienes tienen ese rol. Es del lado del
servidor, así que se mantiene exacto con cualquier tamaño de equipo, y la elección vive en la dirección
de la página — una lista filtrada se puede compartir y guardar en marcadores. Los enlaces **Ver N
miembros** de la pantalla de [Roles](/help/users-permissions-roles) llegan aquí ya filtrados, así que la
lista de Usuarios es el único lugar donde navegas y gestionas la membresía de roles.

## Personas de directorio

Una persona de **directorio** es un usuario sin acceso — creada por la
[importación masiva](/help/assets-bulk-import) como el "asignado a" de un activo, sin cuenta de
acceso. Le dan un propietario registrado a un activo antes de que ese propietario pueda iniciar sesión.

- **En la lista de Usuarios** una persona de directorio lleva una insignia **Directorio** junto a su
  nombre, y el **filtro de directorio** (junto al filtro de estado) acota la lista a *Solo directorio*,
  *Solo cuentas*, o todos.
- **Con tu propio proveedor OIDC, se vinculan a una cuenta real en el primer inicio de sesión**, cuando
  el correo verificado coincide — momento en el que la insignia desaparece y pasan a ser una
  cuenta normal. Una persona de directorio importada **sin un correo real nunca se vincula
  automáticamente**.
- **Dale una cuenta ahora.** Lo que ofrece la página de una persona de directorio depende de cómo tu
  instancia autentica a las personas:
  - **Cuentas locales** — una acción solo para administradores (Gestionar usuarios), **Dar de alta con
    una contraseña temporal**, crea su acceso aquí mismo y muestra una **contraseña temporal de un solo
    uso** para entregar. La contraseña se muestra **una sola vez** (cópiala en ese momento), la persona
    **debe cambiarla en el primer inicio de sesión**, y dar de alta **conserva su rol actual** — nunca
    otorga acceso adicional. No hace falta correo.
  - **Tu propio proveedor OIDC** — lazyit no puede crear cuentas en tu proveedor, así que en lugar de la
    acción aparece una breve nota: crea a la persona allí con el mismo correo verificado, y su primer
    inicio de sesión vincula la cuenta a este registro.

## Restaurar un usuario

Los usuarios dados de baja quedan archivados, no eliminados. Para recuperar uno, muestra los usuarios
archivados en la lista de Usuarios y elige **Restaurar**. Restaurar es solo para administradores.

Restaurar a alguien — o reactivar a quien desactivaste — nunca recupera una sesión anterior: en una
instancia con **cuentas locales**, la persona debe volver a iniciar sesión.

> Dar de baja (y cualquier desactivación) libera los recursos que tenía una persona pero conserva todo
> el historial —quién tuvo qué activo y cuándo, y qué acceso tenía— porque lazyit está construido para
> que las personas roten mientras el registro persiste.

Consulta [Roles](/help/users-permissions-roles) para asignar niveles de acceso y
[Permisos](/help/permissions) para lo que puede hacer cada rol.
