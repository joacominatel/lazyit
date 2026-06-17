---
title: Carpetas y acceso
category: knowledge-base
subcategory: folders-access
order: 2
---

# Carpetas y acceso

Los artículos se organizan en **carpetas**: un árbol navegable, como un sistema de archivos. Las
carpetas son también el lugar donde controlas **quién puede leer** qué artículos.

## Carpetas

Cada artículo tiene **exactamente una carpeta principal**, que se elige como su **Categoría** al
redactarlo. Las carpetas pueden anidarse, así que puedes construir un árbol como
`Servidores / Linux / Aprovisionamiento`. Explora el árbol desde la barra lateral de carpetas en la
Base de conocimiento.

- **Crea una carpeta** desde el botón **+** del formulario de artículo (o desde donde se gestionan las
  carpetas): dale un nombre y, opcionalmente, una carpeta padre.
- **Los nombres son únicos dentro de su carpeta padre.** Pueden coexistir `Servidores / Linux` y
  `Estaciones / Linux`; dos carpetas llamadas `Linux` bajo el *mismo* padre no.
- **Eliminar una carpeta** la quita junto con todo su contenido — sus subcarpetas y todos sus
  artículos — de la Base de conocimiento. La confirmación te indica cuántas carpetas y artículos se
  ven afectados. Los artículos se eliminan de forma lógica (recuperables por un administrador desde la
  base de datos), pero sigue siendo una acción de peso: lee el aviso antes de confirmar.

Para que un artículo *aparezca* en una segunda carpeta sin mover su carpeta principal, usa un
**alias**: consulta [Enlaces y descubrimiento](/help/knowledge-base-linking-discovery). Un alias es
solo de navegación y nunca cambia quién puede leer el artículo.

## Acceso: público por defecto

Una carpeta **sin regla de acceso es Pública**: todos los compañeros con sesión iniciada que pueden
leer la Base de conocimiento ven sus artículos. Es el comportamiento por defecto, así que nada queda
oculto hasta que restringes deliberadamente una carpeta. El acceso solo puede **restringirse** desde
público — una carpeta nunca puede conceder *más* de lo que la Base de conocimiento ya permite.

## Restringir una carpeta

Restringir el acceso es una acción de **administrador**, por carpeta, desde los ajustes de la carpeta
en la barra lateral. Añades una o más **reglas**; quien cumpla **cualquier** regla puede leer la
carpeta (las reglas se combinan con O). Los tipos de regla son:

- **Usuarios** — un conjunto concreto de personas.
- **Rol** — todos los que tengan un rol dado (Administradores, Miembros o Lectores).
- **Acceso a aplicación** — cualquiera que tenga acceso actualmente a una aplicación elegida. Por
  ejemplo: *"quien pueda usar la app de Finanzas puede leer sus runbooks."*
- **Asignados al activo** — quien tenga asignado actualmente un activo elegido. Por ejemplo: *"quien
  tenga el portátil de guardia ve sus notas de emergencia."*

Las dos últimas son **dinámicas**: leen los accesos a aplicaciones y las asignaciones de activos
vigentes en el momento de la lectura. Revoca el acceso a la aplicación de alguien o libera su activo y
su acceso a la Base de conocimiento desaparece automáticamente — no hay un permiso aparte de la Base
de conocimiento que haya que acordarse de quitar cuando alguien deja un proyecto o el equipo.

Una carpeta restringida muestra un icono de **candado**; una pública aparece abierta. Usa **Hacer
público** para quitar todas las reglas y devolver una carpeta al estado por defecto.

### Las restricciones se heredan hacia abajo

Una subcarpeta es **al menos tan restringida como su padre**. Si una carpeta padre está restringida,
sus hijas heredan esa restricción; un administrador puede añadir una regla en una hija para
restringirla *aún más*, pero nunca para ampliarla más allá del padre. Una carpeta que no tiene regla
propia pero está bajo un padre restringido se muestra como **Restringido (heredado de …)**, no como
Público.

## Qué significa "restringido" para quien lee

Cuando una carpeta está restringida, un artículo dentro de ella solo es legible si se cumplen **todas**
estas condiciones:

1. Puedes leer la Base de conocimiento en absoluto (el permiso de lectura de artículos).
2. La carpeta principal del artículo es pública, o alguna de sus reglas te incluye, o eres
   administrador.
3. El artículo está publicado, o es tu propio borrador.

Si no superas la comprobación de carpeta, el artículo devuelve **"artículo no encontrado"** — *no* un
"acceso denegado". Esto es deliberado: el servidor nunca revela que un artículo restringido siquiera
**existe**, igual que oculta los borradores de otras personas. Un documento que no puedes ver es,
sencillamente, inexistente para ti.

## Las garantías detrás del candado

Algunas reglas las impone el servidor, no solo la interfaz:

- **Los administradores lo ven todo.** Las restricciones de carpeta acotan lo que ven quienes no son
  administradores; nunca ocultan un documento a un administrador. (Esto es visibilidad dentro de la
  app — no tiene relación con el Gestor de secretos, donde ni siquiera un administrador puede leer el
  valor cifrado de un secreto.)
- **El candado es real, no decorativo.** El acceso se impone en el servidor y la base de datos, nunca
  solo en la interfaz. Un artículo oculto no puede alcanzarse mediante un enlace directo, una segunda
  pestaña del navegador ni ningún otro cliente — el candado vale en todas partes, no solo en pantalla.
- **Nunca puedes exponer lo que no puedes ver.** No puedes crear un alias, compartir ni exponer de
  otro modo un artículo que tú mismo no tienes permiso para leer.

Consulta [Roles y permisos](/help/permissions) para ver cómo encajan los roles y el permiso de
lectura de artículos.
