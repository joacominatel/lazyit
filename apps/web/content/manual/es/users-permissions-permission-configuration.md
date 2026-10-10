---
title: Configuración de permisos
category: users-permissions
subcategory: permission-configuration
order: 3
---

# Configuración de permisos

Un administrador puede ajustar lo que **Miembro** y **Lector** pueden hacer, eligiendo del catálogo
fijo de permisos. **El Administrador no es configurable** — siempre tiene el catálogo completo y la
pantalla lo muestra bloqueado. Esta página recorre el editor.

Necesitas la capacidad **Cambiar la configuración de la instancia** (administrador por defecto) para
abrirlo.

## Abrir la matriz

Ve a **Configuración → Roles y permisos**. La página es una sola tabla: las **capacidades** en las filas y
los tres **roles** en las columnas, así comparas Miembro y Lector lado a lado.

- **Administrador** es una columna de referencia bloqueada: todas las capacidades están concedidas y no
  se puede cambiar nada.
- **Miembro** y **Lector** son editables. El encabezado de cada columna muestra cuántas personas tienen
  el rol — haz clic para abrir la [lista de Usuarios](/help/users-permissions-user-lifecycle) filtrada
  por ese rol — y el **ajuste predefinido** del rol.

El **?** junto al título de la página explica los tres roles y te recuerda que estos permisos se quedan
dentro de lazyit.

## Tres formas de editar

- **Ajustes predefinidos** — el selector del encabezado de la columna de un rol le aplica un conjunto
  listo: **Editor**, **Solo lectura** u **Operador de inventario**. A partir de ahí puedes ajustar
  capacidades individuales. Cuando el conjunto no coincide con ningún ajuste, el selector muestra
  **Personalizado**.
- **Casillas de capacidad** — capacidades en lenguaje sencillo agrupadas por área (Inventario, Acceso,
  Conocimiento, Gestión, Automatización, IA). Cada una corresponde a uno o varios permisos subyacentes;
  marca o desmarca la casilla en la columna de un rol para otorgar o quitar esa capacidad. El **?** de
  cada capacidad explica qué permite. El área **IA** agrupa **Usar el asistente de IA** (`ai:use`) y
  **Conectar agentes de IA externos (MCP)** (`ai:connect`); ninguno es de nivel administrador, porque el
  asistente y los agentes solo actúan con los permisos del propio rol — ver
  [Asistente de IA — visión general](/help/ai-assistant-overview#quién-puede-usarlo). Una casilla con un
  guion indica que el rol tiene solo **parte** de esa capacidad (ajustada en Ajuste fino); marcarla
  concede la capacidad completa.
- **Ajuste fino (avanzado)** — debajo de la matriz, una sección opcional que lista cada permiso en crudo
  (`área:acción`) con una casilla por rol, para un control exacto. Cambiar uno aquí pasa ese rol a un
  conjunto **Personalizado**, y la capacidad correspondiente se ve concedida en parte en la matriz.

El encabezado de cada área se pliega y despliega, y muestra un recuento **concedidas/total** por rol —
*6/10* significa que el rol tiene seis de las diez capacidades del área completas — así lees toda la
matriz sin abrir cada área. Una celda cambiada se resalta hasta que guardas. **Restablecer valores
predeterminados** devuelve a Miembro y a Lector a su punto de partida original (todavía sin guardar).

## Las concesiones de nivel administrador se marcan, no se bloquean

Puedes darle a Miembro o a Lector capacidades potentes, de nivel administrador —eliminar registros,
conceder acceso a aplicaciones— y también puedes quitar una lectura sensible. Son decisiones reales y
legítimas (dar a un Miembro de confianza la capacidad de eliminar está permitido), así que lazyit **no**
te lo impide. En su lugar, marca las capacidades de nivel administrador con un pequeño **⚠** (su ayuda explica por
qué) y dirige un guardado que conceda una de ellas a través de una breve confirmación que enumera los
efectos. La misma confirmación aparece cuando un guardado quita una lectura que un rol tenía. Confirma y
el cambio se guarda; cualquier otro guardado pasa directamente.

El Administrador es lo único que nunca puedes editar: la matriz no puede otorgar, revocar ni acotar al
Administrador.

## Qué hace guardar

Tus cambios en ambos roles se mantienen juntos hasta que guardas. La barra bajo la matriz los cuenta —
**Guardar 3 cambios** — y **Descartar** lo deja todo como estaba guardado. Guardar escribe juntos, y por
completo, los conjuntos de permisos de Miembro y de Lector. El cambio:

- surte efecto en la **siguiente acción** que realice cada usuario afectado — no necesitan cerrar
  sesión;
- queda **registrado** (cada permiso otorgado o revocado se escribe en el historial de actividad con
  quién hizo el cambio), de modo que la edición es auditable;
- se aplica **por área, no por registro**. Si un rol puede leer activos, puede leer **todos** los
  activos. lazyit no tiene permisos por registro como función general. Las dos excepciones deliberadas
  son las carpetas de la Base de Conocimiento y las bóvedas del Gestor de Secretos, donde el acceso se
  acota a una carpeta o a una bóveda.

## Tus cambios se mantienen tras las actualizaciones

Lo que guardas aquí se mantiene cuando lazyit se actualiza. Un permiso que quitaste a Miembro o a Lector
no vuelve a otorgarse con una actualización posterior.

Cuando una actualización añade un permiso **nuevo**, cada rol recibe el valor por defecto de ese permiso
**una sola vez**, en la primera actualización que lo incluye. A partir de ahí se comporta como cualquier
otro permiso: si lo quitas, sigue quitado en todas las actualizaciones siguientes.

> [!IMPORTANT]
> Antes de este comportamiento, una actualización podía devolver en silencio un permiso por defecto que
> habías quitado. Después de la actualización que lo incorpora, abre esta pantalla una vez y comprueba
> que Miembro y Lector tienen solo lo que pretendes. A partir de entonces, tus cambios se conservan.

## Los permisos se quedan dentro de lazyit

Estos permisos son **solo de lazyit**. Ni ellos ni los roles se escriben nunca en tu proveedor de
identidad — el proveedor no sabe nada de ellos. Los roles y el ajuste fino de permisos que haces aquí
viven por completo dentro de lazyit.

Consulta [Roles](/help/users-permissions-roles) para el modelo de roles y
[Permisos](/help/permissions) para el modelo de área/acción y los valores por defecto que se publican.
