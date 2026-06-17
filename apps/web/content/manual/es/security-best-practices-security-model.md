---
title: Modelo de seguridad
category: security-best-practices
subcategory: security-model
order: 1
---

# Modelo de seguridad

Esta página explica, en términos sencillos, cómo lazyit decide **quién eres** y **qué puedes hacer**.
No necesitas configurar nada de esto para estar seguro — son valores por defecto razonables — pero
entender cómo funciona te ayuda a operar bien la instancia.

## La identidad la aporta tu proveedor, no lazyit

lazyit **no** almacena contraseñas de inicio de sesión. La autenticación se delega a un **proveedor
de identidad (IdP)** que habla OIDC — ya sea el servicio de inicio de sesión incluido con lazyit, o
tu propio proveedor (el SSO de tu empresa). Eliges cuál en la primera ejecución; consulta
[Primeros pasos](/help/getting-started).

Esa única decisión define todo el modelo de seguridad:

- **Tu proveedor es dueño de la credencial de inicio de sesión.** Cuando usas tu propio proveedor,
  lazyit nunca ve, define ni almacena una contraseña de inicio de sesión. Las reglas de contraseñas,
  el doble factor, la política de bloqueo y los restablecimientos de cuenta viven en ese proveedor —
  configúralos allí.
- **lazyit confía en la identidad que afirma tu proveedor.** Tras un inicio de sesión exitoso, lazyit
  te identifica por el identificador de cuenta estable que envía el proveedor, no por algo que un
  usuario pueda escribir. Trata a ese proveedor como la fuente de verdad sobre *quién está iniciando
  sesión*.

> Como la identidad está delegada, la solidez de tu inicio de sesión es la solidez de tu IdP. Activa
> la autenticación multifactor y una política de contraseñas sensata **en tu proveedor** — ahí es
> donde corresponden esos controles.

## Las cuentas se vinculan por correo verificado

La primera vez que alguien inicia sesión a través de tu proveedor, lazyit vincula ese inicio de
sesión a un registro de usuario de lazyit por **correo verificado**. Esto te permite crear de
antemano a una persona en lazyit y que su cuenta "simplemente funcione" la primera vez que inicie
sesión.

Dos salvaguardas lo hacen seguro:

- **El correo debe estar verificado por tu proveedor.** Un correo no verificado nunca se vincula a
  una cuenta existente — así, alguien que se registre con una dirección que no le pertenece no puede
  heredar el registro de otra persona.
- **Un correo ya vinculado a un inicio de sesión nunca se reasigna a otro.** Un inicio de sesión que
  regresa no puede apropiarse de una cuenta, y el registro de una persona dada de baja no se reactiva
  por un inicio de sesión posterior.

## Lo que puedes hacer lo decide lazyit, no tu token

Una vez que has iniciado sesión, **lazyit decide tus permisos a partir de su propia base de datos** —
tu rol y los permisos que hay detrás (consulta [Permisos](/help/permissions)). **No** lee tu rol ni
tus derechos del token de inicio de sesión.

Esto importa: aunque un token estuviera mal configurado o manipulado, no puede otorgar capacidades
dentro de lazyit. Tus capacidades provienen de tu rol en lazyit, que solo un administrador puede
cambiar. Además, mantiene a lazyit portable entre proveedores de identidad — un proveedor OIDC
genérico no necesita saber nada sobre los roles de lazyit.

## Sesiones

Después de iniciar sesión, mantienes una sesión en tu navegador. Cerrar sesión la termina. En el día
a día, esa sesión es lo que prueba ante lazyit quién eres; el trabajo pesado de *probar tu identidad*
ya ocurrió en tu proveedor.

El **Gestor de Secretos** tiene su propio desbloqueo, separado de tu inicio de sesión: está cifrado
de extremo a extremo, así que, aunque hayas iniciado sesión, debes desbloquearlo con una contraseña
específica del Gestor de Secretos que nunca sale de tu navegador. Consulta
[Gestor de Secretos](/help/secret-manager) para ver cómo funciona y por qué ni siquiera un
administrador puede leer tus secretos.

## Lo que esto te da

- **Ninguna base de datos de contraseñas que filtrar.** lazyit no guarda contraseñas de inicio de
  sesión — ahí no hay nada que robar.
- **Un solo lugar para aplicar la política de inicio de sesión** — tu proveedor de identidad — en vez
  de dos.
- **Autorización resistente a manipulación** — tus derechos se leen de la base de datos de lazyit,
  nunca de un token que un cliente pudiera falsificar.
- **Secretos honestos** — el Gestor de Secretos está cifrado de modo que el propio servidor no puede
  leer tus credenciales compartidas.
