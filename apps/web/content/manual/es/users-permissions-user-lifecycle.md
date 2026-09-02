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

- **Nombre y apellido**, y **Correo** — el correo es la clave de vinculación de cuenta con tu proveedor
  de identidad, debe ser único, y un cambio se refleja en el proveedor.
- **Rol** — por defecto es solo lectura; defínelo aquí o cámbialo más tarde. Ver
  [Roles](/help/users-permissions-roles).
- **Número de empleado** y **Nombre de usuario** (ambos opcionales) — datos de directorio, únicos entre
  los usuarios activos. Cuando lazyit gestiona las contraseñas por su cuenta, el nombre de usuario **sí**
  es un identificador de inicio de sesión: la persona puede entrar con su nombre de usuario o con su
  correo. Detrás de un proveedor de identidad es solo un identificador de directorio, nunca una
  credencial.
- **Responsable** (opcional) — un usuario de lazyit existente **o** un nombre de texto libre, no ambos.

**Credencial de inicio de sesión.** Cuando lazyit gestiona las credenciales (el proveedor de identidad
incluido), defines una **contraseña temporal** para que la persona pueda iniciar sesión; ella elige la
suya en el primer inicio. lazyit nunca guarda esta contraseña — se define en el proveedor de identidad
y se reemplaza cuando el usuario inicia sesión, y se muestra una sola vez para la entrega. Si usas tu
propio proveedor de identidad, este paso no aparece — gestiona la credencial en tu proveedor.

**Punto de partida (opcional).** Puedes asignar un activo y conceder acceso a una aplicación desde el
mismo formulario de creación, para que la persona empiece con lo que necesita.

## Clonar un usuario

Para incorporar a alguien que replica a un colega ("el mismo acceso que Ana"), abre un usuario y elige
**Clonar**. Eliges un correo nuevo y único y un rol, y luego seleccionas cuáles de los **activos** y del
**acceso a aplicaciones** del origen se trasladan.

Por defecto, el acceso clonado **solo se registra** — es contabilidad, sin efecto externo. Hay un
interruptor opcional para **aprovisionar al nuevo usuario en estas aplicaciones**, que ejecuta los
flujos de aprovisionamiento de las apps seleccionadas. Tras clonar, lazyit te indica qué se trasladó y
enumera lo que se omitió (y por qué). Un activo o una aplicación seleccionados que se hayan **eliminado**
desde entonces se omiten en lugar de copiarse, para que la clonación nunca reviva un activo retirado ni
una aplicación dada de baja.

## Restablecer una contraseña

En la página de detalle de un usuario, **Restablecer contraseña** inicia el restablecimiento de la
contraseña de esa persona. Lo que hace depende de quién gestiona las contraseñas en tu instancia, y la
acción se adapta sola — nunca tienes que recordar en qué modo estás.

**Cuando un proveedor de identidad gestiona las contraseñas.** lazyit pide a tu proveedor que envíe por
correo a la persona un enlace de restablecimiento. lazyit nunca ve ni define la contraseña — solo
dispara al proveedor, y la entrega depende de que el correo del proveedor esté configurado. La acción no
está disponible para un usuario inactivo (reactívalo primero) ni para una cuenta sin vínculo con el
proveedor de identidad (en ese caso el restablecimiento se gestiona por completo en tu proveedor).

**Cuando lazyit gestiona las contraseñas.** Eliges cómo le llega el restablecimiento a la persona:

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

Cuando alguien se va, ábrelo y elige **Dar de baja**. lazyit muestra el impacto completo de antemano —
los **activos a devolver** y el **acceso a aplicaciones a revocar** — y luego, al confirmar:

- **revoca** el acceso activo a aplicaciones de la persona,
- **quita** el acceso de la persona a cada [bóveda de secretos](/help/secret-manager-vaults-members) a
  la que pertenecía (se elimina su membresía criptográfica),
- **libera** los activos que tiene,
- **archiva** al usuario (un borrado lógico) para que ya no se le puedan asignar activos.

Todo ocurre junto: si algún paso falla, la baja completa se revierte, de modo que una persona nunca queda
a medio dar de baja (archivada pero conservando acceso).

**Rota los secretos que pudo leer.** Si la persona era miembro de alguna bóveda de secretos, la
confirmación lista esas bóvedas (con cuántos secretos tiene cada una) como recordatorio para **rotar esos
secretos a mano**. Quitar su membresía detiene cualquier lectura *nueva*, pero como ya pudo leer esas
bóvedas, conviene cambiar los valores. lazyit **no puede rotarlos por ti** — es zero-knowledge y nunca ve
el texto plano, así que no puede volver a cifrarlos en tu nombre. Es un aviso, no una acción automática.
(Quién quitó el acceso a la bóveda de quién, y cuándo, queda registrado en la auditoría del Gestor de
Secretos.)

**Nada se destruye.** La persona y su historial se conservan para el registro. Puedes completar una nota
de entrega e imprimir un **acta de baja** (con el nombre de la empresa y líneas de firma) para firmar en
papel en la entrega. Dar de baja es válido incluso cuando la persona no tiene nada — sigue valiendo como
constancia de su salida.

## Encontrar usuarios por rol

La lista de Usuarios tiene un **filtro de rol** junto a los filtros de estado y de directorio: elige
**Admin**, **Miembro** o **Lector** para mostrar solo a quienes tienen ese rol. Es del lado del
servidor, así que se mantiene exacto con cualquier tamaño de equipo, y la elección vive en la dirección
de la página — una lista filtrada se puede compartir y guardar en marcadores. Los enlaces **Ver N
miembros** de la pantalla de [Roles](/help/users-permissions-roles) llegan aquí ya filtrados, así que la
lista de Usuarios es el único lugar donde navegas y gestionas la membresía de roles.

## Personas de directorio

Una persona de **directorio** es un usuario sin acceso — creada por la
[importación masiva](/help/assets-bulk-import) como el "asignado a" de un activo, sin cuenta en tu
proveedor de identidad. Le dan un propietario registrado a un activo antes de que ese propietario pueda
iniciar sesión.

- **En la lista de Usuarios** una persona de directorio lleva una insignia **Directorio** junto a su
  nombre, y el **filtro de directorio** (junto al filtro de estado) acota la lista a *Solo directorio*,
  *Solo cuentas*, o todos.
- **Se vinculan a una cuenta real en el primer inicio de sesión** a través de tu proveedor de identidad,
  cuando el correo verificado coincide — momento en el que la insignia desaparece y pasan a ser una
  cuenta normal. Una persona de directorio importada **sin un correo real nunca se vincula
  automáticamente**.
- **Dale una cuenta ahora.** En la página de una persona de directorio hay una acción, solo para
  administradores (Gestionar usuarios), para darla de alta; lo que hace depende de cómo tu instancia
  autentica a las personas:
  - **Proveedor de identidad integrado** — **Crear cuenta OIDC** la aprovisiona en el proveedor de
    identidad de inmediato. El proveedor exige un correo real, así que el botón está deshabilitado hasta
    que la persona tenga uno — edita la persona y agrega un correo real primero.
  - **Modo de autenticación local** — **Dar de alta con una contraseña temporal** crea su acceso aquí
    mismo y muestra una **contraseña temporal de un solo uso** para entregar. La contraseña se muestra
    **una sola vez** (cópiala en ese momento), la persona **debe cambiarla en el primer inicio de sesión**,
    y dar de alta **conserva su rol actual** — nunca otorga acceso adicional. No hace falta correo.
  - **Tu propio proveedor OIDC (BYOI)** — lazyit no puede crear cuentas por ti, así que la opción se
    reemplaza por una breve nota; las personas importadas inician sesión a través de tu proveedor de
    identidad.

## Restaurar un usuario

Los usuarios dados de baja quedan archivados, no eliminados. Para recuperar uno, muestra los usuarios
archivados en la lista de Usuarios y elige **Restaurar**. Restaurar es solo para administradores.

> Dar de baja (y cualquier desactivación) libera los recursos que tenía una persona pero conserva todo
> el historial —quién tuvo qué activo y cuándo, y qué acceso tenía— porque lazyit está construido para
> que las personas roten mientras el registro persiste.

Consulta [Roles](/help/users-permissions-roles) para asignar niveles de acceso y
[Permisos](/help/permissions) para lo que puede hacer cada rol.
