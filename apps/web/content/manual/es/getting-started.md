---
title: Configuración inicial
order: 1
category: getting-started
subcategory: initial-setup
---

# Configuración inicial

Esta página te guía por el primer arranque de una instancia nueva de lazyit: elegir cómo inician
sesión las personas, crear el primer administrador y dar de alta a tu equipo. ¿Empiezas con lazyit?
Lee primero [Introducción](/help/getting-started-introduction).

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
  servicio de inicio de sesión integrado para que el nuevo administrador pueda entrar de inmediato —
  a este primer administrador no se le obliga a cambiarla en el primer inicio de sesión (ese cambio
  obligatorio aplica a los miembros del equipo que agregues después).
- Con **tu propio proveedor**, no se pide ni se envía ninguna contraseña — tu proveedor es el dueño
  de la credencial.

### Paso 4 — Listo

El asistente confirma que se creó el administrador y te lleva a la **página de inicio de sesión**. La
cuenta nueva aún no tiene sesión — inicia sesión como ese administrador para empezar. Una vez dentro,
aparecen los controles de administrador.

## Qué sigue

- **Da de alta a tu equipo** — una vez que inicies sesión como administrador, consulta
  [Usuarios y equipo](/help/getting-started-users-team) para agregar personas, entregar contraseñas
  temporales y entender qué ocurre en el primer inicio de sesión.
- **Cambia el idioma** — lazyit viene en inglés y español; consulta
  [Idiomas](/help/getting-started-languages) para cambiarlo.
- **Permisos** — consulta [Permisos](/help/permissions) para saber quién puede hacer qué y cómo
  ajustar lo que pueden hacer los miembros y los lectores.
- **Gestor de Secretos** — consulta [Gestor de Secretos](/help/secret-manager) para conocer las
  bóvedas cifradas de extremo a extremo y cómo funcionan las claves de recuperación.
