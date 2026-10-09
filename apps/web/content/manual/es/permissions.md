---
title: Permisos
order: 1
category: users-permissions
subcategory: permissions
---

# Permisos

lazyit decide quién puede hacer qué con un modelo pequeño y predecible: **tres roles fijos** y un
**conjunto configurable de permisos** detrás de cada rol. Esta página explica ambos en lenguaje
sencillo y muestra el reparto por defecto de quién-puede-hacer-qué.

## Los tres roles

Cada usuario tiene exactamente un rol. Los roles son fijos —no puedes crear nuevos— y son los mismos
en cada instalación:

- **Administrador** — control total de la instancia. Un administrador puede hacer todo: gestionar
  usuarios, cambiar la configuración, eliminar registros y ajustar lo que pueden hacer los demás
  roles. Esto es deliberado y no se puede reducir; un administrador siempre lo puede todo.
- **Miembro** — el rol de trabajo cotidiano. Los miembros leen y crean/editan la mayoría de las cosas
  (activos, aplicaciones, consumibles, la Base de Conocimiento), pero por defecto no pueden eliminar
  registros ni realizar acciones reservadas al administrador.
- **Lector** — solo lectura. Los lectores pueden mirar la mayoría de las áreas pero no pueden cambiar
  nada, y algunas áreas sensibles quedan ocultas para ellos por defecto.

## Cómo funcionan los permisos

Cada rol tiene un conjunto de **permisos**. Un permiso es una sola capacidad escrita como
`área:acción` — por ejemplo `asset:write` (crear o editar activos) o `consumable:read` (ver
consumibles). Cuando haces algo en lazyit, se comprueba si tu rol tiene el permiso correspondiente.

La lista de permisos posibles (el *catálogo*) es fija y se publica con el producto — no se puede
escribir mal ni inventar. Lo que **sí** puedes cambiar es qué permisos tienen **Miembro** y
**Lector**. **El administrador siempre tiene todos los permisos y no se puede editar** — esto
mantiene la instancia segura de operar (siempre hay un administrador con plena capacidad).

Los administradores ajustan a Miembro y Lector desde **Configuración → Roles y permisos** — una sola
matriz de capacidades en lenguaje sencillo agrupadas por área, con un ajuste predefinido por rol como
punto de partida. Consulta [Configuración de permisos](/help/users-permissions-permission-configuration).

## Quién puede hacer qué (valores por defecto)

Estas son las capacidades **por defecto** de una instalación nueva. Un administrador puede conceder
más a Miembro o Lector (o quitarles algo) desde la pantalla de configuración — son los puntos de
partida, no límites infranqueables.

| Capacidad | Administrador | Miembro | Lector |
| --- | :---: | :---: | :---: |
| **Ver** la mayoría de las áreas (activos, aplicaciones, consumibles, Base de Conocimiento, ubicaciones, modelos, categorías, panel, búsqueda) | Sí | Sí | Sí |
| **Ver** el directorio de usuarios | Sí | Sí | No |
| **Ver** quién-tiene-acceso-a-qué (concesiones de acceso) | Sí | Sí | No |
| **Ver** compras y proveedores | Sí | Sí | No |
| **Registrar y editar** compras y proveedores | Sí | Sí | No |
| **Crear / editar** registros (activos, aplicaciones, consumibles, Base de Conocimiento, …) | Sí | Sí | No |
| **Eliminar** registros | Sí | No | No |
| **Conceder / revocar** acceso a aplicaciones | Sí | No | No |
| **Gestionar usuarios** (crear, editar, cambiar rol, dar de baja, restaurar) | Sí | No | No |
| **Cambiar la configuración** de la instancia (incluidos los permisos) | Sí | No | No |
| **Historial de actividad / informes** | Sí | No | No |
| **Notificaciones** (la campana dentro de la app) | Sí | No | No |
| **Gestor de Secretos** (ver y gestionar bóvedas) | Sí | No | No |
| **Usar el asistente de IA** (`ai:use`) | Sí | Sí | No |
| **Conectar agentes de IA externos (MCP)** (`ai:connect`) | Sí | Sí | No |

Algunas notas sobre los valores por defecto:

- **Tres vistas sensibles quedan ocultas para el Lector**: el directorio de usuarios, el registro de
  concesiones de acceso (quién tiene acceso a qué) y las [compras y proveedores](/help/purchases-recording-purchases)
  (llevan precios). El Administrador y el Miembro las conservan. Concederle una al Lector se la concede a
  todos los lectores — los permisos son del rol, no de la persona.
- **Algunas áreas son solo de administrador por defecto**: el historial de actividad de todo el
  parque, la campana de notificaciones y el Gestor de Secretos. Son las superficies más sensibles,
  por eso empiezan reservadas al administrador. Un administrador puede concederlas a Miembro o Lector
  si lo desea.
- **Eliminar** registros y **conceder acceso a aplicaciones** son acciones solo de administrador por
  defecto.
- **Los dos permisos de IA suman un canal, no un poder.** El asistente y los agentes externos actúan con
  los permisos de la propia persona, y no pasa nada hasta que un administrador activa la IA o MCP en
  **Configuración → IA**. Mirá [Asistente de IA — visión general](/help/ai-assistant-overview#quién-puede-usarlo).

## Ajustar a Miembro y Lector

Cuando le das a Miembro o a Lector una capacidad de nivel administrador —como poder eliminar
registros o conceder acceso a aplicaciones— lazyit lo marca con claridad y te pide confirmación,
porque es una delegación importante. No te lo impide: dar a un Miembro de confianza la capacidad de
eliminar es una decisión legítima. El Administrador, en cambio, nunca es editable.

> Los permisos son por **área**, no por registro individual. lazyit no tiene control de acceso por
> registro como función general — si un rol puede leer activos, puede leer todos los activos. (Las
> carpetas de la Base de Conocimiento y las bóvedas del Gestor de Secretos son las dos excepciones
> deliberadas, donde el acceso se acota a una carpeta o a una bóveda.)

## Más en esta sección

- [Roles](/help/users-permissions-roles) — los tres roles fijos y cómo se asignan.
- [Configuración de permisos](/help/users-permissions-permission-configuration) — editar los conjuntos
  de permisos de Miembro y Lector.
- [Cuentas de servicio](/help/users-permissions-service-accounts) — credenciales de API no humanas y
  acotadas.
- [Ciclo de vida del usuario](/help/users-permissions-user-lifecycle) — crear, clonar, dar de baja y
  restaurar personas.
