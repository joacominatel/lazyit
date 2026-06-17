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

## Abrir el editor

Ve a **Configuración → Roles**. Cada rol muestra quién lo tiene y un breve resumen de lo que puede
hacer. El Administrador aparece como **Acceso total — no editable**. Para Miembro o Lector, elige
**Editar permisos** para abrir el editor de **permisos de rol**.

El editor trabaja con **un rol a la vez**. Elige **Miembro** o **Lector** arriba; el Administrador se
muestra pero bloqueado.

## Tres formas de editar

- **Ajustes predefinidos** — **Empezar desde un ajuste predefinido** aplica un conjunto listo y
  razonable como punto de partida. A partir de ahí puedes ajustar capacidades individuales. Si tu
  conjunto no coincide con ningún ajuste, lazyit lo etiqueta como **Personalizado**.
- **Conmutadores de capacidad** — interruptores en lenguaje sencillo agrupados por área (Inventario,
  Acceso, Conocimiento, Gestión, Automatización). Cada conmutador corresponde a uno o varios permisos
  subyacentes; actívalo o desactívalo para otorgar o quitar esa capacidad al rol.
- **Ajuste fino (avanzado)** — una sección opcional donde cada interruptor es un permiso individual en
  crudo (`área:acción`), para un control exacto. Cambiar uno aquí pasa el rol a un conjunto
  **Personalizado** y actualiza los conmutadores de capacidad de arriba para que coincidan.

Un resumen en vivo de **Qué puede hacer este rol** muestra, por área, si el rol queda con **Ver y
editar**, **Solo ver** o **Sin acceso**, para que puedas comprobarlo antes de guardar. **Restablecer
los valores por defecto** devuelve el rol a su punto de partida original.

## Las concesiones de nivel administrador se marcan, no se bloquean

Puedes darle a Miembro o a Lector capacidades potentes, de nivel administrador —eliminar registros,
conceder acceso a aplicaciones— y también puedes quitar una lectura sensible. Son decisiones reales y
legítimas (dar a un Miembro de confianza la capacidad de eliminar está permitido), así que lazyit **no**
te lo impide. En su lugar, marca las concesiones de nivel administrador con una etiqueta
**Nivel administrador** y dirige un guardado que incluya una de ellas a través de una breve
confirmación que enumera los efectos. Confirma y el cambio se guarda.

El Administrador es lo único que nunca puedes editar: el editor no puede otorgar, revocar ni acotar al
Administrador.

## Qué hace guardar

Guardar reemplaza por completo el conjunto de permisos del rol elegido. El cambio:

- surte efecto en la **siguiente acción** que realice cada usuario afectado — no necesitan cerrar
  sesión;
- queda **registrado** (cada permiso otorgado o revocado se escribe en el historial de actividad con
  quién hizo el cambio), de modo que la edición es auditable;
- se aplica **por área, no por registro**. Si un rol puede leer activos, puede leer **todos** los
  activos. lazyit no tiene permisos por registro como función general. Las dos excepciones deliberadas
  son las carpetas de la Base de Conocimiento y las bóvedas del Gestor de Secretos, donde el acceso se
  acota a una carpeta o a una bóveda.

## Los permisos se quedan dentro de lazyit

Estos permisos son **solo de lazyit**. Nunca se escriben en tu proveedor de identidad — el proveedor no
sabe nada de ellos. Solo los tres roles generales se reflejan en el proveedor (cuando hay uno
configurado); el ajuste fino de permisos que haces aquí vive por completo dentro de lazyit.

Consulta [Roles](/help/users-permissions-roles) para el modelo de roles y
[Permisos](/help/permissions) para el modelo de área/acción y los valores por defecto que se publican.
