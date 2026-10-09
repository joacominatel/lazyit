---
title: Cuentas de servicio
category: users-permissions
subcategory: service-accounts
order: 4
---

# Cuentas de servicio

Una **cuenta de servicio** es una credencial no humana para automatización — un ejecutor de CI que
registra un activo recién aprovisionado, un script nocturno que reconcilia stock, una integración que
abre concesiones de acceso. Llama a la API de lazyit con su propio token en lugar del inicio de sesión
de una persona.

Las cuentas de servicio son un tipo de principal distinto de los usuarios: nunca aparecen en el
directorio de usuarios, nunca cuentan para la regla del último administrador y no dependen de tu
proveedor de identidad. Las gestionas en **Configuración → Cuentas de servicio** (solo administradores).

La página muestra cada cuenta en una fila: su nombre y el comienzo de su token, sus permisos como chips
(pasados tres, el resto se agrupa en **+N** — pasa el puntero por encima, o léelo con un lector de
pantalla, para ver la lista completa), cuándo se usó por última vez y cuándo vence su token — o una
insignia cuando está **revocada**, **vencida** o **inactiva**. El menú **⋯** de una fila reúne
**Cómo probarla**, **Editar**, **Rotar token**, **Acceso a IA** y **Revocar**. **Mostrar revocadas** cambia a
las cuentas revocadas, cada una con **Restaurar**. Sin cuentas todavía, la página es una línea con el
botón **Nueva cuenta de servicio**.

## Cómo se autoriza una cuenta de servicio

Una cuenta de servicio se autoriza **solo por los permisos que le otorgas** — del mismo catálogo que
usan los usuarios. **Nunca** hereda un rol ni equivale a un administrador.

- **Debes otorgar al menos un permiso.** Una cuenta de servicio sin permisos podría autenticarse pero
  no hacer nada.
- **Es de cierre por defecto (fail-closed).** Una cuenta de servicio solo puede actuar en los
  endpoints cuyo permiso requerido posee por completo. A diferencia de una persona con sesión iniciada,
  no obtiene un pase en rutas no anotadas — cualquier cosa que no se le haya otorgado explícitamente
  devuelve un error de permiso.
- **Otórgale el mínimo que necesite.** Acota cada cuenta exactamente a las capacidades que requiere su
  tarea. Puedes otorgar eliminaciones y otras capacidades de nivel administrador; el selector las marca
  como **Nivel administrador**.
- **Dos capacidades nunca son otorgables.** Una cuenta de servicio nunca puede tener **Cambiar la
  configuración de la instancia** ni **Gestionar usuarios**. Cualquiera de las dos la haría equivalente
  a un administrador (capaz de crear más cuentas o de crear un administrador humano), así que lazyit las
  rechaza — aunque intentes asignarlas.

## El token (se muestra una sola vez)

Crear una cuenta genera un token. **Se muestra exactamente una vez**, justo después de crear la cuenta.

- Cáptalo de inmediato y guárdalo en un lugar seguro. Usa **Copiar** o **Descargar** (guarda el token
  como un archivo `.txt`); además el token es totalmente seleccionable, así que puedes seleccionarlo y
  copiarlo a mano. lazyit guarda solo un hash del token, así que **nunca** se puede volver a mostrar ni
  recuperar.
- El panel **permanece abierto hasta que confirmes** que guardaste el token — Escape, hacer clic fuera y
  el botón de cerrar quedan deshabilitados hasta entonces, para que no se cierre por accidente y se pierda.
- En una instalación por HTTP plano (sin HTTPS), el navegador puede bloquear **Copiar**; lazyit te lo
  avisa y puedes usar **Descargar** (o seleccionar el token a mano) en su lugar — la captura nunca
  depende del portapapeles.
- Si lo pierdes, no puedes recuperarlo — **rota** la cuenta para generar uno nuevo.
- En la fila de la cuenta se muestra un prefijo corto y no secreto (p. ej. `lzit_sa_…`) para que
  reconozcas qué credencial es cuál sin revelar nada utilizable.

Hay un asistente **Probar que funciona** que te da comprobaciones listas para ejecutar en la terminal,
acotadas a los permisos que tiene la cuenta, para que confirmes que el token se autentica y está acotado
como esperas antes de cablearlo en un sistema.

## Gestionar las cuentas con el tiempo

- **Conmutador Activa** — una desactivación suave. Apágalo y el token deja de autenticar, sin revocar
  la cuenta; vuelve a encenderlo para reanudar.
- **Caducidad (opcional)** — fija una hora de *caducidad* y el token se rechaza a partir de ese momento.
  Déjalo vacío para que no caduque.
- **Rotar** — genera un token nuevo e **inmediatamente deja de funcionar el anterior**. Todo sistema que
  use el token antiguo debe actualizarse. El nuevo token, de nuevo, se muestra una sola vez.
- **Revocar (eliminar)** — deshabilita la credencial. Se conserva para el historial (un borrado lógico)
  y un administrador puede **restaurarla** más tarde; las cuentas revocadas quedan ocultas salvo que
  elijas incluirlas.
- **Auditoría** — cada creación, rotación, cambio de permisos, revocación y restauración queda
  registrado, y cualquier acción que realice una cuenta de servicio se atribuye a esa cuenta en el
  historial de actividad, nunca a una persona.

> **Revocar suspende el token — no elimina el acceso a las bóvedas.** Revocar solo detiene la
> autenticación del token; cualquier bóveda del Gestor de Secretos que la cuenta tuviera concedida sigue
> concedida, así que **restaurarla** más tarde reanuda todas esas bóvedas sin necesidad de volver a
> otorgarlas. Si una cuenta de servicio debe perder la capacidad de leer una bóveda en particular,
> revócala desde la lista de **Miembros** de esa bóveda — consulta [Bóvedas y miembros](/help/secret-manager-vaults-members).

## Usar el asistente de IA sin una persona

Una cuenta de servicio puede usar el [asistente de IA](/help/ai-assistant-overview) sin una persona —
un script envía un prompt a `POST /api/ai/runs` y sigue la ejecución — o conectarse a lazyit por MCP
con su token. En los dos casos actúa exactamente con sus propios permisos, y **nadie aprueba sus
cambios uno por uno**. Tres cosas la acotan:

- **Sus permisos** — otorgale **Usar el asistente de IA** (`ai:use`) para la API, **Conectar agentes de
  IA externos (MCP)** (`ai:connect`) para MCP, y solo los permisos de dominio que el trabajo necesita.
- **Su acceso a IA** — menú de la fila → **Acceso a IA**: desactivado, solo lectura, o lectura y
  escritura, con un tope opcional (**Limitar escrituras**) por ejecución (por hora móvil en MCP) que
  cuenta cada registro modificado. Mirá [Cuentas de servicio](/help/ai-assistant-setup#cuentas-de-servicio)
  en la página de configuración de la IA.
- **Los interruptores de la instancia** — el asistente (para la API) o MCP tienen que estar activos en
  **Configuración → IA**.

Las ejecuciones headless nunca buscan en la web. A una cuenta que tiene **Reportar inventario de
servidores (agente)** se le niega el uso de IA; creá una cuenta aparte para la IA.

## Cuentas gestionadas por el sistema

Algunas cuentas las crea y posee lazyit en sí — por ejemplo la cuenta con la que el Motor de Flujos de
Trabajo de Aplicaciones ejecuta cada flujo. Llevan una etiqueta de **gestionada por el sistema** y no se
pueden editar, rotar ni revocar, porque la función que las posee las necesita para seguir funcionando.

Consulta [Permisos](/help/permissions) para el catálogo de capacidades y
[Configuración de permisos](/help/users-permissions-permission-configuration) para el mismo modelo de
área/acción aplicado a los roles.
