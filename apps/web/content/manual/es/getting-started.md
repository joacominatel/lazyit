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

## De cero a /setup

¿Todavía no tienes lazyit corriendo? En un host Linux con Docker, dos comandos te dejan una instancia
en marcha:

```sh
git clone https://github.com/joacominatel/lazyit && cd lazyit
./infra/start.sh
```

`start.sh` es un script guiado e idempotente: detecta Docker, puertos libres y los recursos del host,
hace unas seis preguntas que no puede completar de forma segura por su cuenta (dominio, TLS, proveedor
de identidad, etc.), genera `infra/env/.env.prod` con secretos aleatorios reales, levanta el stack
completo con Docker Compose y muestra tu URL. Es seguro volver a ejecutarlo — es no destructivo y
nunca sobrescribe secretos existentes.

Cuando termina, abre **`https://tu-host/setup`** — el resto de esta página recorre ese asistente.

Para configuraciones avanzadas (tu propio proveedor de identidad OIDC, un Postgres externo, TLS en un
dominio real), consulta [Autoalojamiento](/help/deployment-operations-self-hosting). Para actualizar
una instancia existente más adelante, ejecuta `./infra/update.sh`.

## Antes de empezar

Cómo inician sesión las personas se elige **una sola vez, al desplegar**, y queda fijo durante toda la
vida de la instancia. Hay dos familias:

- **Cuentas locales** (`AUTH_MODE=local`, la opción por defecto) — lazyit se encarga del inicio de
  sesión. Cada persona tiene un nombre de usuario/correo y una contraseña guardados en la app (como
  hash). **No** hay proveedor de identidad externo ni nada extra que ejecutar — la forma más simple de
  levantar lazyit. Creas el primer administrador (con contraseña) durante la configuración.
- **Tu propio proveedor OIDC** (`AUTH_MODE=oidc`) — lazyit no guarda contraseñas; el inicio de sesión se
  delega en un **proveedor de identidad (IdP)** que ya administras, como el SSO de tu empresa. lazyit lo
  encuentra con unas pocas variables de entorno, que el instalador guiado te pide y el asistente de
  configuración vuelve a mostrar:

  ```
  # App web
  AUTH_ISSUER=https://auth.example.com
  AUTH_CLIENT_ID=your-client-id
  AUTH_CLIENT_SECRET=your-client-secret

  # API
  AUTH_MODE=oidc
  OIDC_ISSUER=https://auth.example.com
  OIDC_CLIENT_ID=your-client-id
  OIDC_JWKS_URI=https://auth.example.com/.well-known/jwks.json
  ```

  Tu proveedor se encarga de las contraseñas y del inicio de sesión; los usuarios y los roles quedan en
  lazyit.

> **El modo de autenticación es inmutable.** Cambiar una instancia entre cuentas locales y OIDC después
> de que tenga usuarios no está soportado (sus credenciales no se trasladan). Decídelo desde el
> principio. Para el detalle del lado del despliegue, consulta
> [Proveedor de identidad](/help/deployment-operations-identity-provider).

## El asistente de configuración

La primera vez que abres una instancia nueva, lazyit muestra un breve **asistente de configuración**
a pantalla completa. El asistente se ejecuta **una sola vez**: en cuanto existe un administrador, la
instancia queda configurada y el asistente te lleva a la página de inicio de sesión. Los pasos se
adaptan a cómo se desplegó la instancia.

### Paso 1 — Bienvenida

Aquí no hay nada que elegir — el modo de inicio de sesión queda fijo al desplegar. Una tarjeta lo
explica:

- En una instancia de **cuentas locales**, confirma que estás configurando las cuentas propias de
  lazyit.
- En una instancia **OIDC**, indica que se usa tu propio proveedor OIDC y muestra las variables de
  entorno de arriba, con un botón para copiarlas, para que compruebes que están definidas en la app web
  y en la API.

### Paso 2 — Configurar (solo OIDC)

En una instancia de cuentas locales este paso se omite.

En una instancia OIDC, este paso vuelve a mostrar las variables de entorno y te pide confirmar que tu
proveedor está conectado antes de crear el primer administrador. El correo del administrador **debe
existir ya en tu proveedor**, verificado, para que pueda iniciar sesión: en ese primer inicio de sesión
lazyit vincula ambas cuentas por el correo.

### Paso 3 — Crear el primer administrador

Ingresa el **nombre, apellido y correo** del primer administrador. El rol está fijado en
**Administrador** — este paso existe solo para crear el primer administrador, por eso el rol se
muestra como una insignia bloqueada, no como un campo editable.

- Con **cuentas locales**, aquí también defines una **contraseña inicial**, con una lista de
  verificación en vivo de las reglas de la contraseña. lazyit la guarda (como hash), el nuevo
  administrador puede entrar de inmediato, y a este primer administrador no se le obliga a cambiarla en
  el primer inicio de sesión (ese cambio obligatorio aplica a los miembros del equipo que agregues
  después).
- Con **tu propio proveedor OIDC**, no se pide ni se envía ninguna contraseña — tu proveedor es el dueño
  de la credencial.

### Paso 4 — Listo

El asistente confirma que se creó el administrador y te lleva a la **página de inicio de sesión**. La
cuenta nueva aún no tiene sesión — inicia sesión como ese administrador para empezar. En una instancia de
cuentas locales inicias sesión con el correo/nombre de usuario y la contraseña que acabas de definir; en
una instancia OIDC inicias sesión a través de tu proveedor. Una vez dentro, aparecen los controles de
administrador.

> **Si tu sesión expira**, lazyit te devuelve a la página de inicio de sesión para que vuelvas a
> entrar — solo inicia sesión de nuevo para retomar donde lo dejaste.

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
