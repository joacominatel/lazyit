---
title: Proveedor de identidad
order: 4
category: deployment-operations
subcategory: identity-provider
---

# Proveedor de identidad

lazyit no almacena por sí mismo las contraseñas de inicio de sesión. El inicio de sesión se delega en un
**proveedor de identidad** que habla **OIDC**. Eliges entre dos opciones al desplegar, y puedes cambiar
después sin tocar el código.

> Para la parte del usuario final de esta decisión (el asistente del primer arranque, añadir miembros al
> equipo), consulta [Primeros pasos](/help/getting-started).

## Opción 1 — el proveedor de identidad incluido (recomendado)

lazyit incluye **Zitadel** ya integrado. Con el flujo incluido, el inicio de sesión funciona sin
configuración adicional:

- Un paso de arranque puntual aprovisiona toda la integración OIDC en el primer arranque — el proyecto,
  la aplicación OIDC, los roles y una cuenta de servicio — **sin tocar la consola**. Nunca copias un id
  de cliente o un secreto a mano.
- El proveedor incluido se ejecuta como dos contenedores (el proveedor en sí y su propia base de datos),
  accesibles en el **subdominio `auth.`** de tu dominio, servidos por HTTPS a través del proxy inverso.
- Solo defines un puñado de valores en el archivo de entorno: la URL externa de autenticación, tu
  dominio, la clave maestra y una contraseña de administrador del primer arranque. El arranque aporta el
  resto.

Esta es la vía feliz. El primer administrador se crea más tarde, en el asistente de configuración dentro
de la app — el arranque del proveedor de identidad nunca crea un usuario de la aplicación.

> La **clave maestra** del proveedor de identidad es irrotable e irremplazable, y es lo que hace legible
> una base de datos de proveedor restaurada. Trátala como una joya de la corona y respáldala fuera del
> servidor. Consulta [Copias de seguridad y restauración](/help/deployment-operations-backups-restore).

## Opción 2 — usa tu propio proveedor (BYOI)

Si ya tienes un proveedor de identidad compatible con OIDC — Azure AD / Entra ID, Okta, Keycloak,
Authentik y similares — conecta lazyit a él en su lugar. El backend habla **OIDC estándar** y no usa
ninguna API específica del proveedor, así que esto **no requiere cambios de código**.

Para cambiar:

1. En tu proveedor, registra una aplicación y anota su **URL de emisor (issuer)**, su **id de cliente**
   y su **secreto de cliente**.
2. En el archivo de entorno, define los tres valores OIDC para que apunten a tu proveedor (emisor, id de
   cliente, secreto de cliente), más los valores de inicio de sesión correspondientes que lee la web.
3. **Elimina los servicios de Zitadel incluidos** para que el arranque no se ejecute (el proveedor, su
   base de datos y el ayudante de arranque).
4. Configura la **URI de redirección** en tu proveedor con la URL de retorno de tu instancia, con la
   forma `https://tudominio.com/api/auth/callback/<nombre-proveedor>`.
5. Recrea los servicios afectados.

Con tu propio proveedor, ese proveedor es el dueño de las contraseñas y de la creación de cuentas —
lazyit nunca define ni almacena una contraseña de inicio de sesión. La base de datos de la aplicación no
se ve afectada en absoluto por el cambio.

## La autorización permanece en lazyit

Sea cual sea el proveedor, **lo que puede hacer cada persona** se decide enteramente dentro de lazyit.
Los permisos y los roles se guardan en la base de datos de la aplicación y nunca tocan el proveedor de
identidad, así que se mantienen sin cambios al cambiar de proveedor. El proveedor de identidad solo
responde «quién es esta persona»; lazyit responde «qué puede hacer». Consulta
[Permisos](/help/permissions).

Una persona que inicia sesión a través de tu proveedor antes de haber sido añadida en lazyit puede
aprovisionarse automáticamente en ese primer inicio de sesión, asociándose a un registro por correo
electrónico verificado.

## Nota sobre el modo tipo producción local

Cuando ejecutas la pila completa en tu propia máquina para pruebas, el subdominio de autenticación es
`auth.localhost`. La mayoría de los sistemas resuelven `*.localhost` a tu máquina automáticamente; si el
tuyo no, añade `127.0.0.1 auth.localhost` a tu archivo de hosts para que el navegador pueda llegar a la
página de inicio de sesión. En ese caso, la URL del emisor debe incluir el puerto HTTPS alto.

## Relacionado

- [Autoalojamiento](/help/deployment-operations-self-hosting)
- [Servicios](/help/deployment-operations-services)
- [Proxy inverso y TLS](/help/deployment-operations-reverse-proxy-tls)
- [Primeros pasos](/help/getting-started)
- [Permisos](/help/permissions)
