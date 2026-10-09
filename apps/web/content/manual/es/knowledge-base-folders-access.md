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
`Servidores / Linux / Aprovisionamiento`. Explora el árbol en la sección **Carpetas** de la barra
lateral de la Base de conocimiento, debajo de las vistas (consulta
[Explorar la Base de conocimiento](/help/knowledge-base-articles-authoring#explorar-la-base-de-conocimiento)).

- **Cada carpeta tiene un cuadro de color** — un pequeño cuadrado de color junto a su nombre. El color
  se elige automáticamente a partir de la carpeta y es el mismo en todas partes (la barra lateral, las
  tarjetas de la página de inicio, la página de la carpeta) y para todos. Es solo una ayuda visual; dos
  carpetas pueden compartir color.
- **Cada carpeta muestra cuántos artículos contiene** — un pequeño número a la derecha de la fila de
  la carpeta. Cuenta solo los artículos que **realmente puedes ver** (los publicados, más tus propios
  borradores), así que nunca revela más de lo que mostraría la lista de la carpeta. Una **carpeta
  restringida que no puedes leer no muestra número**, y las carpetas en un servidor más antiguo
  simplemente no muestran ninguno hasta que se actualice.
- **Una carpeta restringida muestra un candado** en su fila — consulta
  [Restringir una carpeta](#restringir-una-carpeta). Todos ven el candado, no solo los administradores.
- **Crea una carpeta de primer nivel** con el **+** junto al título **Carpetas** de la barra lateral, o
  con la tarjeta punteada **Nueva carpeta** de la página de inicio de la Base de conocimiento.
- **Crea una subcarpeta** desde el menú **⋯** de la carpeta dentro de la que la quieres → **Nueva
  subcarpeta aquí**, o con **Subcarpeta** en la página de esa carpeta. No hay límite de profundidad:
  anida tanto como necesite tu documentación. La carpeta nueva se abre en cuanto se crea.
- **El menú ⋯** aparece cuando pasas el puntero por una fila de carpeta, cuando llegas a ella con el
  teclado y siempre en la carpeta seleccionada; en una pantalla táctil está siempre visible. Contiene
  **Nueva subcarpeta aquí**, **Editar**, **Mover a…**, **Acceso…** (administradores) y **Eliminar
  carpeta**, cada opción visible solo para quien puede usarla.
- **Edita una carpeta** desde el menú **⋯** → **Editar**. Puedes cambiar su **nombre**, su
  **descripción** (una frase que se muestra en su tarjeta y en su página) y su **orden** — un número
  entero opcional: los más bajos van primero, y las carpetas sin orden van después, por nombre. Editar
  nunca mueve la carpeta ni cambia quién puede leerla. La descripción y el orden se pueden cambiar pero
  todavía no quitar: si vacías el campo, el diálogo te lo indica y se mantiene el valor actual.
- **Mueve una carpeta** con **Mover a…** en el mismo menú. Elige cualquier otra carpeta como nuevo
  padre, o **Primer nivel (sin padre)** para devolverla a la raíz; sus subcarpetas y sus artículos se
  mueven con ella.
- **Los nombres son únicos dentro de su carpeta padre.** Pueden coexistir `Servidores / Linux` y
  `Estaciones / Linux`; dos carpetas llamadas `Linux` bajo el *mismo* padre no. Si el nombre ya está
  ocupado donde estás creando o moviendo, la app te lo dice y no se cambia nada.
- **Una carpeta no puede moverse dentro de sí misma** ni de una de sus subcarpetas: eso desprendería
  la rama del árbol. El movimiento se rechaza con una explicación.
- **Eliminar una carpeta** la quita junto con todo su contenido — sus subcarpetas y todos sus
  artículos — de la Base de conocimiento. La confirmación te indica cuántas carpetas y artículos se
  ven afectados. Los artículos se eliminan de forma lógica (recuperables por un administrador desde la
  base de datos), pero sigue siendo una acción de peso: lee el aviso antes de confirmar.

Las carpetas se crean, se describen y se ordenan aquí, en la Base de conocimiento; **Configuración →
Taxonomías** te trae aquí para ellas.

## La página de una carpeta

Al seleccionar una carpeta se abre su página. Arriba, una **ruta de navegación** muestra la ruta
completa de la carpeta; cada tramo es un enlace para subir por el árbol. Debajo, una tarjeta de
encabezado reúne el cuadro de color, el nombre y la descripción de la carpeta, y cuatro datos:

- **Quién la ve** — **Todos con acceso a la base** para una carpeta pública. Para una restringida,
  los administradores ven las reglas en palabras, como *Solo Administradores*, *Solo 3 personas* o
  *Solo quienes tienen acceso a Finanzas*; el resto ve **Restringido**. Una carpeta restringida por una
  carpeta padre dice **Restringida · por** esa carpeta.
- **Artículos** — el número de artículos propios de la carpeta (el mismo que en la barra lateral).
- **Subcarpetas** — cuántas carpetas hay directamente dentro.
- **Último cambio** — cuándo se actualizó por última vez un artículo de la carpeta.

Las acciones del encabezado:

- **Artículo aquí** abre el editor de artículos con esta carpeta ya elegida como **Categoría**.
  Puedes elegir otra carpeta antes de guardar.
- **Subcarpeta** crea una carpeta dentro de esta.
- **⋯** ofrece **Editar**, **Mover a…**, **Acceso…** (administradores) y **Eliminar carpeta** — el
  mismo menú que en la barra lateral.

Debajo del encabezado, las **subcarpetas** aparecen como una fila de chips: selecciona una para
abrirla. Después viene **En esta carpeta**: los artículos de la carpeta, en la misma tabla que la
página de inicio pero sin la columna Carpeta (ya estás en ella), con el mismo filtro de estado, orden y
filtros.

### Incluir subcarpetas

Una carpeta con subcarpetas muestra un interruptor **Incluir subcarpetas** sobre su lista. Apagado
(por defecto), la lista muestra solo los artículos guardados directamente en la carpeta. Encendido,
muestra los artículos de la carpeta **y todo lo guardado en cualquier nivel por debajo**, y cada
artículo de una subcarpeta muestra el nombre de esa subcarpeta antes de su resumen, para que sigas
sabiendo dónde vive. **Último cambio** también sigue al interruptor. El acceso por carpeta se sigue
aplicando: los artículos de una subcarpeta que no puedes leer quedan fuera de la lista. El interruptor
forma parte de la dirección de la página, así que un enlace que compartas se abre igual.

Para que un artículo *aparezca* en una segunda carpeta sin mover su carpeta principal, usa un
**alias**: consulta [Enlaces y descubrimiento](/help/knowledge-base-linking-discovery). Un alias es
solo de navegación y nunca cambia quién puede leer el artículo.

## Acceso: público por defecto

Una carpeta **sin regla de acceso es Pública**: todos los compañeros con sesión iniciada que pueden
leer la Base de conocimiento ven sus artículos. Es el comportamiento por defecto, así que nada queda
oculto hasta que restringes deliberadamente una carpeta. El acceso solo puede **restringirse** desde
público — una carpeta nunca puede conceder *más* de lo que la Base de conocimiento ya permite.

## Restringir una carpeta

Restringir el acceso es una acción de **administrador**, por carpeta, desde el menú **⋯** de la
carpeta → **Acceso…** (en la barra lateral o en la página de la carpeta). Añades una o más **reglas**; quien cumpla **cualquier** regla puede leer la
carpeta (las reglas se combinan con O). Los tipos de regla son:

- **Usuarios** — un conjunto concreto de personas.
- **Rol** — todos los que tengan un rol dado (Administradores, Miembros u Observadores).
- **Acceso a aplicación** — cualquiera que tenga acceso actualmente a una aplicación elegida. Por
  ejemplo: *"quien pueda usar la app de Finanzas puede leer sus runbooks."*
- **Asignados al activo** — quien tenga asignado actualmente un activo elegido. Por ejemplo: *"quien
  tenga el portátil de guardia ve sus notas de emergencia."*

Las dos últimas son **dinámicas**: leen los accesos a aplicaciones y las asignaciones de activos
vigentes en el momento de la lectura. Revoca el acceso a la aplicación de alguien o libera su activo y
su acceso a la Base de conocimiento desaparece automáticamente — no hay un permiso aparte de la Base
de conocimiento que haya que acordarse de quitar cuando alguien deja un proyecto o el equipo.

Una carpeta restringida muestra un **candado** junto a su nombre — en la barra lateral, en su tarjeta
de la página de inicio (que además dice **Restringido**), en la columna Carpeta de la lista de
artículos y en los resultados de búsqueda. Una carpeta pública no muestra ninguno. Una carpeta que solo
está restringida porque lo está una carpeta padre muestra un candado más tenue; pasa el puntero por
encima para ver cuál. Usa **Hacer público** para quitar todas las reglas y devolver una carpeta al
estado por defecto.

### Las restricciones se heredan hacia abajo

Una subcarpeta es **al menos tan restringida como su padre**. Si una carpeta padre está restringida,
sus hijas heredan esa restricción; un administrador puede añadir una regla en una hija para
restringirla *aún más*, pero nunca para ampliarla más allá del padre. Una carpeta que no tiene regla
propia pero está bajo un padre restringido se muestra como **Restringido (heredado de …)**, no como
Público.

**Mover una carpeta cambia lo que hereda.** Si la colocas bajo un padre restringido, ella — y todo su
contenido — pasa a estar al menos tan restringida como ese padre, de inmediato. Si la devuelves al
primer nivel, solo queda su *propia* regla. Un movimiento nunca concede acceso que la Base de
conocimiento no permitiera ya, pero sí puede devolver una carpeta a su regla propia, así que revisa el
destino antes de mover una carpeta que dependía de la restricción de su padre.

### Los movimientos que cambian quién puede leer piden confirmación

La carpeta principal de un artículo **es** su regla de acceso, así que cambiar de carpeta cambia quién
puede leerlo. Cuando un movimiento puede permitir que más personas lean algo, la app pregunta antes de
guardar:

- **De una carpeta restringida a una pública** — cambiar la **Categoría** de un artículo a una carpeta
  sin ninguna restricción avisa de que **todos los que pueden leer la Base de conocimiento podrán leer
  este artículo**. Mover una carpeta desde debajo de un padre restringido a un lugar sin restricción
  avisa lo mismo sobre sus artículos (las subcarpetas con reglas propias siguen restringidas por ellas).
- **Entre dos lugares restringidos de forma distinta** — el artículo, o los artículos de la carpeta
  movida, pasarán a seguir las reglas del destino. La app no puede decirte *a quién* dejan entrar esas
  reglas, así que indica claramente que esto **puede** permitir que más personas lo lean.

**Cancelar** deja todo donde estaba; confirmar guarda el movimiento. No hay aviso cuando el origen es
público, cuando el destino conserva todas las restricciones que tenía el origen (las mismas carpetas,
o esas y alguna más — lo que solo puede reducir quién lo lee), o cuando la carpeta no cambia en
realidad. Sacar un documento de una carpeta restringida está permitido a
propósito — redactar un informe en una carpeta restringida y publicarlo una vez depurado es un flujo
normal —; el aviso existe para que nunca ocurra por accidente.

> [!NOTE]
> El aviso depende de que el servidor le indique a la app qué carpetas están restringidas. Con un
> servidor anterior a esta función, la app no puede saberlo, así que mueve sin preguntar en lugar de
> adivinar.

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
