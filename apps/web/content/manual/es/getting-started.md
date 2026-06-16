---
title: Primeros pasos
order: 1
section: Primeros pasos
---

# Primeros pasos

Bienvenido a lazyit — una herramienta autoalojada de inventario y accesos para equipos de IT
pequeños. Esta página te guía por el primer arranque: elegir cómo inician sesión las personas, crear
el primer administrador y dar de alta a tu equipo.

> Este Manual es la documentación propia del producto, publicada junto con el código y servida desde
> una página pública, sin inicio de sesión. Es distinto de la Base de Conocimiento: el Manual
> documenta *lazyit en sí*, la Base de Conocimiento documenta *tu parque*.

## Antes de empezar

lazyit no guarda las contraseñas de inicio de sesión por sí mismo. El inicio de sesión se delega en
un **proveedor de identidad (IdP)** que habla OIDC. Tienes dos opciones, y eliges entre ellas en el
primer arranque:

- **Inicio de sesión integrado** — lazyit incluye un servicio de inicio de sesión (Zitadel) ya
  configurado. Es el camino sencillo: nada que configurar aparte, y defines la contraseña del primer
  administrador durante la configuración.
- **Usa tu propio proveedor (BYOI)** — conecta lazyit a tu proveedor de identidad OIDC existente
  (por ejemplo, el SSO de tu empresa). lazyit lee tres variables de entorno para encontrarlo:

  ```
  AUTH_ISSUER=https://auth.example.com
  AUTH_CLIENT_ID=your-client-id
  AUTH_CLIENT_SECRET=your-client-secret
  ```

  Con tu propio proveedor, ese proveedor es el dueño de las contraseñas y de la creación de cuentas —
  lazyit nunca define ni almacena una contraseña de inicio de sesión.

## El asistente de configuración

La primera vez que abres una instancia nueva, lazyit muestra un breve **asistente de configuración**
a pantalla completa. El asistente se ejecuta **una sola vez**: en cuanto existe un administrador, la
instancia queda configurada y el asistente te lleva a la página de inicio de sesión. Los pasos se
adaptan a la opción de inicio de sesión que elijas.

### Paso 1 — Bienvenida y elección de inicio de sesión

Elige cómo iniciarán sesión las personas: **inicio de sesión integrado** o **usar tu propio
proveedor**. La elección se muestra como dos tarjetas; selecciona una para continuar. Elegir *usar
tu propio proveedor* revela las tres variables de entorno de arriba para que confirmes que están
definidas.

### Paso 2 — Configurar (solo para tu propio proveedor)

Si elegiste el inicio de sesión integrado, este paso se omite — el servicio integrado ya está
aprovisionado, así que no hay nada que ingresar. (Puede que aún esté terminando su propio arranque la
primera vez; es normal.)

Si elegiste tu propio proveedor, este paso vuelve a mostrar las tres variables de entorno para que
las confirmes antes de crear el primer administrador. El correo del administrador **debe existir ya
en tu proveedor** para que pueda iniciar sesión.

### Paso 3 — Crear el primer administrador

Ingresa el **nombre, apellido y correo** del primer administrador. El rol está fijado en
**Administrador** — este paso existe solo para crear el primer administrador, por eso el rol se
muestra como una insignia bloqueada, no como un campo editable.

- Con el **inicio de sesión integrado**, aquí también defines una **contraseña inicial**, con una
  lista de verificación en vivo de las reglas de la contraseña. lazyit define esa contraseña en el
  servicio de inicio de sesión integrado para que el nuevo administrador pueda entrar. Se le pedirá
  que elija la suya en el primer inicio de sesión.
- Con **tu propio proveedor**, no se pide ni se envía ninguna contraseña — tu proveedor es el dueño
  de la credencial.

### Paso 4 — Listo

El asistente confirma que se creó el administrador y te lleva a la **página de inicio de sesión**. La
cuenta nueva aún no tiene sesión — inicia sesión como ese administrador para empezar. Una vez dentro,
aparecen los controles de administrador.

## Dar de alta al resto del equipo

Tras la configuración, un administrador agrega a los miembros del equipo desde el área de
**Usuarios**. Usa **Nuevo usuario** para abrir el formulario de alta completo, que recoge:

- **Identidad** — correo, nombre y apellido, y campos opcionales como el nombre de usuario y el
  responsable.
- **Credencial de inicio de sesión** — con el **inicio de sesión integrado**, defines una
  **contraseña temporal** de un solo uso para entregársela a la persona; ella elige la suya en el
  primer inicio de sesión. lazyit nunca la almacena — se define en el servicio de inicio de sesión y
  se reemplaza cuando el usuario inicia sesión. Con **tu propio proveedor**, esto queda oculto; tu
  proveedor es el dueño de la credencial.
- **Ventaja inicial (opcional)** — puedes asignar un activo o conceder acceso a una aplicación a la
  persona nueva directamente desde el formulario de creación.

Después de crear el usuario, lazyit muestra la contraseña temporal **una sola vez** para que puedas
entregarla — no se vuelve a mostrar.

> Si una persona inicia sesión a través de tu proveedor de identidad antes de darla de alta en
> lazyit, lazyit puede aprovisionar su cuenta automáticamente en ese primer inicio de sesión y
> vincularla a un registro coincidente por correo verificado.

## Qué sigue

- **Permisos** — consulta [Permisos](/help/permissions) para saber quién puede hacer qué y cómo
  ajustar lo que pueden hacer los miembros y los lectores.
- **Gestor de Secretos** — consulta [Gestor de Secretos](/help/secret-manager) para conocer las
  bóvedas cifradas de extremo a extremo y cómo funcionan las claves de recuperación.
