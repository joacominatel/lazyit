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

## Cómo inicias sesión

El inicio de sesión funciona de una de dos formas, elegida una sola vez al desplegar la instancia;
consulta [Primeros pasos](/help/getting-started).

- **Cuentas locales (la opción por defecto).** lazyit se encarga del inicio de sesión. Guarda cada
  contraseña solo como **hash argon2id** — una huella lenta, con sal y de un solo sentido — nunca la
  contraseña en sí, así que nadie, ni siquiera un administrador, puede volver a leerla. Los intentos
  fallidos repetidos se ralentizan y se limitan, y lazyit emite su propia sesión firmada. En esta
  versión el inicio de sesión es solo con contraseña.
- **Tu propio proveedor OIDC.** La autenticación se delega en un **proveedor de identidad (IdP)** que
  administras, como el SSO de tu empresa. lazyit nunca ve, define ni almacena una contraseña de inicio
  de sesión: las reglas de contraseñas, el multifactor, la política de bloqueo y los restablecimientos
  de cuenta viven en ese proveedor — configúralos allí. lazyit confía en la identidad que afirma tu
  proveedor: tras un inicio de sesión exitoso, te identifica por el identificador de cuenta estable que
  envía el proveedor, no por algo que un usuario pueda escribir.

> Con cuentas locales, la solidez de tu inicio de sesión es la solidez de tus contraseñas — usa
> contraseñas largas y únicas. Con tu propio proveedor, es la solidez de tu IdP: activa la
> autenticación multifactor y una política de contraseñas sensata **allí**. Si hoy necesitas
> multifactor, conecta tu propio proveedor.

## Las cuentas se vinculan por correo verificado (OIDC)

La primera vez que alguien inicia sesión a través de tu propio proveedor, lazyit vincula ese inicio de
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
ya ocurrió al iniciar sesión.

En una instancia con **cuentas locales**, una sesión dura 12 horas salvo que la persona marque
**Mantener la sesión iniciada**, que la conserva hasta que cierre sesión. Esa sesión no tiene ningún
límite de tiempo detrás, así que está pensada solo para dispositivos personales y de confianza. Cerrar
sesión termina las sesiones de la persona en **todos** sus dispositivos, y lo mismo ocurre al cambiar o
restablecer la contraseña, al desactivar la cuenta o al darla de baja. Consulta
[Tu perfil](/help/getting-started-your-profile) para ver lo que ve cada persona.

**Las apps de IA conectadas por MCP no son sesiones.** Cerrar sesión no las desconecta; cambiar o
restablecer la contraseña, desactivar la cuenta o darla de baja sí, y cada persona puede revocar una
cuando quiera. Mirá [Qué termina una conexión](/help/ai-assistant-connected-apps#qué-termina-una-conexión).

El **Gestor de Secretos** tiene su propio desbloqueo, separado de tu inicio de sesión: está cifrado
de extremo a extremo, así que, aunque hayas iniciado sesión, debes desbloquearlo con una contraseña
específica del Gestor de Secretos que nunca sale de tu navegador. Consulta
[Gestor de Secretos](/help/secret-manager) para ver cómo funciona y por qué ni siquiera un
administrador puede leer tus secretos.

## El asistente de IA y los agentes externos

La IA está desactivada hasta que un administrador la activa, y nunca amplía los derechos de nadie: el
asistente integrado, los agentes externos por MCP y las ejecuciones headless de cuentas de servicio
actúan **como** una persona o cuenta de servicio, y lazyit lo verifica en cada llamada igual que un clic
en la app. Lo que cambia es adónde van los datos y quién decide:

- **Los datos salen hacia el proveedor de IA.** Lo que el asistente lee para una persona — cualquier
  registro que esa persona puede ver — se envía al proveedor que eligió el administrador, bajo tu
  contrato con él. Los secretos, nunca. Leé [Qué sale de tu servidor](/help/ai-assistant-overview#qué-sale-de-tu-servidor)
  antes de activarla.
- **Un texto puede intentar manejar al modelo** (inyección de prompts). El asistente integrado no puede
  cambiar nada sin una tarjeta de aprobación que lazyit arma a partir del cambio real; un cambio
  propuesto después de leer contenido de otra persona queda marcado y nunca se aprueba automáticamente;
  los cambios de privilegios e identidad piden la contraseña de la persona. Mirá
  [Cómo lazyit mantiene al asistente bajo control](/help/ai-assistant-overview#cómo-lazyit-mantiene-al-asistente-bajo-control).
- **Los agentes externos deciden por su cuenta.** Por MCP, el cliente — no lazyit — pregunta antes de un
  cambio, y los datos de lazyit van al proveedor del propio cliente. El acceso de nivel administrador
  nunca viene preseleccionado y pide contraseña. Mirá
  [Antes de conectar](/help/ai-assistant-claude-code-mcp#antes-de-conectar-en-qué-confiás).

## Lo que esto te da

- **Ninguna contraseña legible.** Con cuentas locales lazyit solo guarda hashes argon2id; con tu
  propio proveedor no guarda ninguna contraseña de inicio de sesión.
- **Un solo lugar para aplicar la política de inicio de sesión** — lazyit con cuentas locales, o tu
  proveedor de identidad — nunca dos.
- **Autorización resistente a manipulación** — tus derechos se leen de la base de datos de lazyit,
  nunca de un token que un cliente pudiera falsificar.
- **Secretos honestos** — el Gestor de Secretos está cifrado de modo que el propio servidor no puede
  leer tus credenciales compartidas.
