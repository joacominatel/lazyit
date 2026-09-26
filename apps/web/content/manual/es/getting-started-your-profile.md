---
title: Tu perfil
order: 1
category: getting-started
subcategory: your-profile
---

# Tu perfil

**Tu perfil** es tu vista personal y de autoservicio de lo que lazyit te asignó **a vos** — sin
necesidad de un administrador. Responde las dos preguntas que todo miembro del equipo termina
haciéndose: *"¿qué notebook (o teléfono, o monitor) tengo?"* y *"¿a qué aplicaciones puedo entrar?"*

## Cómo abrirlo

Hacé clic en tu **avatar**, arriba a la derecha, y elegí **Mi perfil**. Está disponible para **todos**,
incluidas las cuentas de solo lectura (**Viewer**): nunca necesitás permisos elevados para ver lo tuyo.

## Tu cuenta

**Cuenta** (menú del avatar → **Cuenta**, en `/account`) es el lugar único para todo lo que tiene que ver
con **tu propia** cuenta. Todos pueden abrirla; muestra solo lo que te corresponde:

- **Vos** — tu nombre, email, rol y fecha de alta, con un atajo a **Mi perfil**.
- **Tus páginas** — tarjetas para **Mi perfil**, [Correos de notificación](/help/notifications-activity-email-preferences),
  **IA y apps conectadas** (solo si podés conectar apps de IA y tu instancia tiene el asistente — ver
  [Apps conectadas](/help/ai-assistant-connected-apps)) y el **Secret Manager** (solo si podés leer
  secretos — ahí está tu contraseña personal de bóveda).
- **Contraseña y sesiones** — quién gestiona tu contraseña (lazyit o el proveedor de inicio de sesión de
  tu organización), un atajo a **Cambiar contraseña** en instancias con cuentas locales y un botón para
  cerrar sesión. Con cuentas locales dice **Cerrar sesión en todos los dispositivos**, porque cerrar
  sesión ya termina todas tus sesiones (ver [Iniciar y cerrar sesión](#iniciar-y-cerrar-sesión)). lazyit
  no lista tus sesiones ni dispositivos uno por uno.
- **Preferencias** — tu **idioma** y tu **tema** (claro, oscuro o el de tu dispositivo). Mirá
  [Tu idioma y tu tema en todos tus dispositivos](#tu-idioma-y-tu-tema-en-todos-tus-dispositivos).

Una fila de pestañas arriba de **Cuenta**, **Mi perfil**, **Correos de notificación** e **IA y apps
conectadas** te permite pasar de una a otra sin volver al menú.

## Qué vas a ver

- **Nombre** — tu nombre y apellido, que podés editar vos mismo (ver
  [Editar tu nombre](#editar-tu-nombre)).
- **Identidad** — tu correo, rol y la fecha de alta. Junto con tu nombre, así es exactamente como te ve
  el resto del equipo.
- **Mis activos** — cada activo **actualmente asignado a vos** (una asignación vigente). Cada fila
  muestra el nombre del activo, su modelo y ubicación, y su estado. Elegí **Ver** para abrir la página
  completa del activo.
- **Mi acceso a aplicaciones** — las aplicaciones a las que podés acceder ahora, cada una con su nivel
  de acceso y, cuando corresponde, su fecha de vencimiento. Si una concesión venció, se marca como
  **Vencido**.
- **Accesos anteriores** — un historial de las aplicaciones a las que *tenías* acceso, con cuándo
  empezó cada concesión y cuándo se revocó. Esta sección aparece solo si tenés accesos pasados.

## Editar tu nombre

Podés corregir tu propio **nombre y apellido**: un error de tipeo, un cambio de apellido, el nombre con
el que realmente te conocen.

1. Abrí **Mi perfil** y elegí **Editar nombre** en el panel **Nombre**.
2. Cambiá el nombre, el apellido o los dos (de 1 a 100 caracteres cada uno) y elegí **Guardar**.

El nombre nuevo aparece en todos lados al instante: en el menú de arriba a la derecha, en los
responsables de activos y concesiones, y en la lista de **Usuarios**. Si tu organización inicia sesión
con el servicio de inicio de sesión incluido en lazyit, tu nombre también se actualiza ahí. El cambio
queda registrado en tu historial de usuario, como cualquier otro cambio de nombre.

Solo se puede editar el nombre. Tu correo, rol, legajo, nombre de usuario y responsable siguen en manos
de los administradores.

**Cuando tu nombre viene del directorio de la empresa.** Si tu instancia sincroniza personas desde
Active Directory o LDAP y vos sos una de ellas, el directorio es dueño de tu nombre. El panel **Nombre**
lo muestra de solo lectura, con una nota que lo explica: un cambio acá solo se sobrescribiría en la
próxima sincronización. Pedile a un administrador que lo cambie en el directorio.

**Si no se puede guardar.** Si en ese momento no se puede actualizar el servicio de inicio de sesión,
lazyit no cambia nada y te lo avisa: probá de nuevo en un momento. Las cuentas de servicio no tienen
perfil, así que no pueden editar un nombre.

## Tu idioma y tu tema en todos tus dispositivos

Tu **idioma** y tu **tema** se guardan en el navegador donde los elegís **y** en tu cuenta. Cambialos
donde quieras —el panel **Preferencias** de **Cuenta**, la fila de idioma del menú del avatar o el botón
de tema de la barra superior— y las dos cosas pasan a la vez.

**Siempre gana el navegador que estás usando.** Tu elección guardada se usa solo en un navegador que no
tiene una propia: normalmente la primera vez que iniciás sesión en una computadora o un teléfono nuevo,
lazyit toma el idioma y el tema que elegiste en otro lado. Un navegador donde ya elegiste algo conserva
su propia elección, así podés tener tema oscuro en casa y claro en el trabajo. Mirá
[Idiomas](/help/getting-started-languages).

## Iniciar y cerrar sesión

**Cerrar sesión.** Hacé clic en tu **avatar**, en la esquina superior derecha, y elegí **Cerrar sesión**.

Si tu instancia usa **cuentas locales** (un email/nombre de usuario y contraseña de lazyit):

- **Un inicio de sesión normal dura 12 horas.** Pasado ese tiempo, lazyit te lleva de vuelta a la
  pantalla de inicio de sesión y volvés a iniciarla. Lo que hayas abierto mientras tanto (un marcador,
  un enlace) espera detrás de la pantalla de inicio de sesión y se abre cuando volvés a entrar.
- **Mantener la sesión iniciada.** Marcá **Mantener la sesión iniciada** en la pantalla de inicio de
  sesión y tu sesión **no vence**: seguís con la sesión iniciada en ese navegador hasta que la cierres.
  Está desactivado por defecto y lo elegís en cada inicio de sesión.
- **Usalo solo en un dispositivo personal y de confianza.** Como la sesión nunca vence, cualquiera que
  pueda usar ese navegador queda conectado como vos hasta que cierres sesión. Nunca lo marques en una
  computadora compartida, pública o prestada. La pantalla de inicio de sesión muestra esta advertencia
  cuando marcás la casilla.
- **Cerrar sesión cierra tus sesiones en todos los dispositivos.** Al elegir **Cerrar sesión** se cierran
  todas tus sesiones: este navegador, tus otras computadoras y tu teléfono, incluidas las que mantuviste
  con **Mantener la sesión iniciada**. Así también cerrás una sesión que dejaste abierta en otro lado.
- Una sesión mantenida también termina cuando cambiás tu contraseña (solo en los otros dispositivos),
  cuando un administrador restablece tu contraseña o cuando tu cuenta se desactiva o se da de baja.

> **Con inicio de sesión único (SSO)** no hay casilla **Mantener la sesión iniciada**: cuánto tiempo
> seguís con la sesión iniciada lo define tu proveedor de identidad, y cerrar sesión termina tu sesión
> en este navegador.

## Cambiar tu contraseña

Si tu instancia usa **cuentas locales** (un email/nombre de usuario y contraseña de lazyit, en lugar del
inicio de sesión único de tu organización), tu perfil también tiene un panel **Cambiar tu contraseña**:

- Ingresá tu contraseña **actual** y luego tu **nueva** contraseña dos veces. La nueva debe cumplir la
  lista de requisitos en vivo (longitud, mayúscula y minúscula, un número y un símbolo) y debe ser
  distinta de la actual.
- Al cambiarla **seguís con la sesión iniciada en este dispositivo**; cualquier *otra* sesión se cierra,
  así que cambiar la contraseña también sirve para cerrar una sesión olvidada o compartida.

> **Con inicio de sesión único (SSO)** no hay panel de contraseña: tu proveedor de identidad es dueño de
> tu contraseña y la cambiás allí. Esta sección aplica solo a instancias con cuentas locales.

### Tu primer inicio de sesión (contraseña temporal)

Cuando un administrador crea tu cuenta local, te entrega una contraseña **temporal**. La primera vez que
inicias sesión con ella, lazyit **te exige definir tu propia contraseña antes de poder hacer cualquier
otra cosa**: una pantalla completa que no podés saltear hasta elegir una nueva. Una vez que lo hacés,
entrás directo a la aplicación.

### ¿Olvidaste tu contraseña?

En la pantalla de inicio de sesión, elegí **¿Olvidaste tu contraseña?**, ingresá tu email o nombre de
usuario y —si el correo está configurado en tu instancia— lazyit envía un **enlace de restablecimiento
de un solo uso** (vence en breve). Por tu seguridad, la confirmación se ve igual haya coincidido o no una
cuenta, así que nunca revela quién tiene una cuenta. Abrí el enlace, elegí una nueva contraseña e iniciá
sesión. Si el correo no está configurado, pedile a un administrador que restablezca tu contraseña.

## De solo lectura por diseño

Salvo tu propio nombre y tu contraseña (arriba), tu perfil es una **vista**, no un editor. No podés reasignar un
activo ni otorgarte acceso desde acá: esas acciones quedan en manos de los administradores, así la página
siempre es una foto segura y fiel de tu situación actual. Si algo se ve mal (un activo que ya no tenés,
un acceso que todavía necesitás), contactá a un administrador — cada asignación y concesión tiene marca
de tiempo, así que el historial es fácil de reconciliar.

## Relacionado

- La página completa del activo (a la que llegás desde **Ver**) muestra números de serie,
  especificaciones y el historial propio del activo.
- Los administradores pueden ver la misma foto de activos/accesos de **cualquier** persona desde la
  sección **Usuarios**.
