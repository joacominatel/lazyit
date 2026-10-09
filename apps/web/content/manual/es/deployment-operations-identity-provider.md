---
title: Proveedor de identidad
order: 4
category: deployment-operations
subcategory: identity-provider
---

# Proveedor de identidad

lazyit ofrece dos formas de iniciar sesión, elegidas **una sola vez al desplegar** mediante `AUTH_MODE`
y luego **inmutables** durante toda la vida de la instancia:

- **Cuentas locales** (`AUTH_MODE=local`, la opción por defecto) — lazyit se encarga del inicio de
  sesión (nombre de usuario/correo + contraseña), **sin proveedor de identidad externo**. Es la opción
  más simple y la que elige el instalador guiado salvo que indiques otra cosa.
- **Tu propio proveedor OIDC** (`AUTH_MODE=oidc`) — el inicio de sesión se delega en un **proveedor de
  identidad que ya administras** y que habla **OIDC**: Entra ID, Okta, Keycloak, Authentik y similares.
  En este modo lazyit no guarda ninguna contraseña de inicio de sesión.

Cambiar una instancia de una forma a la otra con la base de datos ya en uso no está soportado — las
credenciales no se trasladan. Decídelo desde el principio.

> Para la parte del usuario final de esta decisión (el asistente del primer arranque, añadir miembros al
> equipo), consulta [Primeros pasos](/help/getting-started).

## Cuentas locales (por defecto)

Con `AUTH_MODE=local`, lazyit funciona **sin ningún proveedor de identidad externo** — sin issuer OIDC
ni servicios adicionales que mantener. lazyit guarda él mismo la credencial de cada persona (las
contraseñas se guardan como hash **argon2id**) y emite su propia sesión firmada al iniciar sesión. Es el
patrón habitual del autoalojamiento (Gitea, Portainer, Proxmox) y el de menos piezas móviles para un
despliegue interno pequeño.

- **Primer arranque.** El asistente de configuración confirma que estás configurando cuentas locales y
  te lleva directo a crear el primer administrador con **nombre, correo y contraseña**. Esa contraseña
  se guarda (como hash) como la credencial del administrador.
- **Página de inicio de sesión.** `/login` muestra un formulario de **nombre de usuario/correo +
  contraseña**.
- **Dar de alta personas.** Un administrador crea a cada usuario con una contraseña temporal
  directamente en lazyit; no hay alta automática en el primer inicio de sesión (eso solo ocurre con
  OIDC).
- **El secreto de firma.** El modo local requiere un `SESSION_SIGNING_SECRET` persistente (que el
  instalador guiado genera por ti). Es distinto de `AUTH_SECRET`. Rotarlo solo obliga a todos a iniciar
  sesión de nuevo — sin pérdida de datos — pero mantenlo estable para que los reinicios no cierren la
  sesión de todos.
- **Sin MFA todavía.** El modo local es solo contraseña en esta versión; el multifactor solo está
  disponible a través de un proveedor OIDC que lo ofrezca. Si necesitas MFA hoy, conecta tu propio
  proveedor.
- **¿Perdiste la contraseña del último administrador?** Un **comando de recuperación** de un solo uso
  (ejecutado en el host) restablece directamente la contraseña de un administrador concreto. Consulta
  [Solución de problemas](/help/deployment-operations-troubleshooting).

> **El modo local y el Gestor de Secretos.** El Gestor de Secretos sigue cifrado de extremo a extremo: tu
> contraseña de inicio de sesión **no** es la frase de acceso de tu bóveda. Son credenciales separadas por
> diseño — no reutilices una como la otra. Consulta [Gestor de Secretos](/help/secret-manager).

## Tu propio proveedor OIDC

Si ya tienes un proveedor de identidad compatible con OIDC, conecta lazyit a él. El backend habla **OIDC
estándar** y no usa ninguna API específica del proveedor, así que **no hace falta tocar código** — solo
variables de entorno.

1. **Registra lazyit en tu proveedor** como aplicación OIDC (un cliente web confidencial). Anota su
   **URL de emisor (issuer)**, su **ID de cliente** y su **secreto de cliente**, y el **`jwks_uri`** que
   figura en el documento de descubrimiento del proveedor (`<issuer>/.well-known/openid-configuration`).
2. **Configura la URI de redirección** en tu proveedor con la URL de retorno de tu instancia:
   `https://tudominio.com/api/auth/callback/oidc`.
3. **Pásale los valores a lazyit.** El instalador guiado (`./infra/start.sh`) te los pide cuando eliges
   *tu propio proveedor OIDC* en la pregunta de autenticación, y los escribe por ti. Para definirlos a
   mano, ponlos en `infra/env/.env.prod` — la app web lee los tres primeros y la API el resto:

   ```sh
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

   `OIDC_ISSUER` y `OIDC_JWKS_URI` son **obligatorias** — sin ellas la API se niega a arrancar en modo
   OIDC. Si tu proveedor corre en el mismo host y su dirección pública no se resuelve desde dentro de
   los contenedores, define también `AUTH_INTERNAL_ISSUER` con una dirección a la que la app web pueda
   llegar.
4. **Recrea la app web y la API**, y abre `/setup`. El asistente muestra las mismas variables para que
   las revises antes de crear el primer administrador.

El **modo LAN** del instalador (HTTP sin cifrar) solo funciona con cuentas locales: la URI de
redirección OIDC se registra contra una dirección fija, así que no puede seguir a una IP que cambia.

### De qué se encarga tu proveedor

Con tu propio proveedor, este es la fuente de verdad de las **credenciales**, y lazyit no se mete:

- **Contraseñas, multifactor, bloqueos y sesiones** viven en tu proveedor — configúralos allí. lazyit
  nunca ve, define ni guarda una contraseña de inicio de sesión, y la acción **Restablecer contraseña**
  del administrador no aparece.
- **Las personas se crean en los dos lados.** Da de alta a la persona en lazyit (**Usuarios → Nuevo
  usuario**) y en tu proveedor con el **mismo correo**. En su primer inicio de sesión, lazyit vincula
  ambas cuentas por **correo verificado**. Quien pueda iniciar sesión en tu proveedor y todavía no
  exista en lazyit recibe una cuenta nueva de **Lector** en ese primer inicio de sesión.
- **lazyit nunca escribe en tu proveedor.** Los cambios de nombre, correo y rol hechos en lazyit se
  quedan en lazyit, y lazyit no puede crearte una cuenta en tu proveedor.
- **Dar de baja en lazyit bloquea el inicio de sesión en lazyit.** Dar de baja a alguien deja activa
  su cuenta en el proveedor, pero lazyit rechaza su inicio de sesión — aunque nunca hubiera entrado,
  siempre que tu proveedor marque su correo como verificado. Lo que le permite volver es restaurar al
  usuario. Aun así, desactiva la cuenta en tu proveedor como parte de tu proceso de salida: lazyit solo
  puede bloquear lazyit, no las demás aplicaciones a las que tu proveedor le da entrada.

## La autorización permanece en lazyit

Uses la forma de inicio de sesión que uses, **lo que puede hacer cada persona** se decide enteramente
dentro de lazyit. Los permisos y los roles se guardan en la base de datos de la aplicación y nunca tocan
el proveedor de identidad. El proveedor solo responde «quién es esta persona»; lazyit responde «qué
puede hacer». Consulta [Permisos](/help/permissions).

## Relacionado

- [Autoalojamiento](/help/deployment-operations-self-hosting)
- [Servicios](/help/deployment-operations-services)
- [Proxy inverso y TLS](/help/deployment-operations-reverse-proxy-tls)
- [Primeros pasos](/help/getting-started)
- [Permisos](/help/permissions)
