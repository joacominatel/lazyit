---
title: Diagrama de infraestructura
category: assets
subcategory: topology
order: 1
---

# Diagrama de infraestructura

El **Diagrama** es un mapa de movimiento libre de tu parque de servidores — hosts, máquinas
virtuales, contenedores, clústeres, dispositivos de red, almacenamiento y más — dibujado como
tarjetas arrastrables unidas por relaciones tipadas. Es un inventario visual genérico de *cómo se
relacionan tus cosas*: qué máquina corre sobre qué host, qué pertenece a un clúster, qué respalda a
dónde, qué depende de qué.

Lo abres desde la barra lateral en **Activos › Topología**. La misma pantalla tiene un interruptor
**Mapa ⇄ Tabla** arriba a la derecha: el **Mapa** es este tablero de movimiento libre, y la **Tabla**
es una lista plana y filtrable de los mismos nodos — ver
[Lista de servidores](/help/assets-topology-servers).

> Cualquiera que pueda ver la topología ve el mapa y el detalle de solo lectura de cada nodo.
> Agregar nodos, dibujar conexiones, cambiar un estado o quitar un nodo del mapa requiere el permiso
> de gestión; sin él los controles simplemente no aparecen.

## El lienzo

El tablero es una superficie que se desplaza y hace zoom, con fondo punteado y un minimapa pequeño.
Arrastra un nodo para reubicarlo: la nueva posición se guarda automáticamente cuando termina el
arrastre, así que la disposición que armes es la que todos verán la próxima vez. Usa los controles
de la esquina (o tu trackpad/scroll) para hacer zoom y ajustar la vista.

Con el permiso de gestión, un botón **Ordenar** aparece en la esquina superior derecha del tablero.
Al hacer clic, reorganiza todo el mapa en una disposición limpia de arriba hacia abajo — los hosts
por encima de las máquinas que corren sobre ellos, los grupos por encima de sus miembros — cada vez
que el mapa se enreda tras mucho arrastrar y conectar. Las nuevas posiciones se guardan y igual
puedes arrastrar cualquier nodo después. Un nodo nuevo que creas aparece en el centro de tu vista
actual (y las creaciones consecutivas se abren en abanico para no apilarse), así que siempre llega
donde puedes verlo.

Cada nodo es una tarjeta compacta que muestra:

- un **icono de tipo** (host, VM, contenedor, clúster, dispositivo de red, almacenamiento,
  aparato u otro),
- la **etiqueta** del nodo (su nombre en el mapa),
- una **píldora de estado** (ver *Estado* más abajo), y
- su **dirección IP**, cuando está definida.

Al pasar el cursor por una tarjeta aparece un pequeño tooltip con datos rápidos (tipo, estado, IP).
Al hacer clic en una tarjeta se abre el **panel de detalle** a la derecha — el verdadero valor (lo
vemos abajo).

## Crear un nodo

Con el permiso de gestión verás un botón **Agregar nodo** en el encabezado de la página. El
formulario pide lo justo para poner una cosa en el mapa:

- **Etiqueta** — obligatoria. El nombre mostrado en el lienzo (por ejemplo `pve1`, `NAS-01`,
  `switch-core`).
- **Tipo** — obligatorio. Elige el tipo genérico más cercano. El modelo es deliberadamente agnóstico
  de plataforma: un pod de Kubernetes es un *Contenedor*, un namespace o una cuenta de nube es un
  *Clúster* u *Otro* — no hay tipos específicos de plataforma que aprender.
- **Rastrear como activo** — un interruptor, **activado por defecto** (ver abajo).

### Rastrear como activo

La mayoría de las cosas del mapa son inventario real que posees — un host, un NAS, un switch, una
Raspberry Pi, una VM de larga vida — así que por defecto un nodo nuevo está **respaldado por un
activo**:

- Dejándolo **activado**, lazyit vincula el nodo a un activo de inventario. Puedes elegir un activo
  existente para vincular, o dejarlo en blanco y lazyit crea uno mínimo (con el nombre de la
  etiqueta) por ti. A partir de ahí el nodo hereda todo lo que ese activo lleva — su responsable, sus
  artículos de la base de conocimiento vinculados, su garantía, sus accesos directos.
- Desactivándolo, obtienes un nodo **solo de grafo**, la opción correcta para cosas efímeras que no
  inventarías (un contenedor de vida corta, por ejemplo). Aparece en el mapa pero no tiene registro
  de inventario detrás.

Puedes cambiar de opinión después. Desvincular el activo de un nodo respaldado deja el nodo en el
mapa pero quita el vínculo de inventario: si lazyit había creado el activo automáticamente, ese
activo se desactiva (nunca queda en el inventario sin dueño); si habías vinculado un activo
preexistente, queda intacto y simplemente se desvincula.

La **etiqueta del nodo siempre manda para mostrarse** en el lienzo; el nombre del activo vinculado
aparece en el panel de detalle como un *nombre de inventario* secundario, así que ambos nunca se
desfasan en silencio. Ese nombre de inventario es un **enlace de vuelta al activo** —hacé clic para
abrir su registro completo—. La propia página de detalle del activo cierra el círculo en sentido
contrario: muestra una insignia **En la topología** y un botón **Ver en la topología** que vuela el
mapa hasta este nodo (ver [Conceptos básicos de activos](/help/assets-asset-basics)).

## Relaciones (conexiones)

Dos nodos se unen mediante una **conexión tipada y direccional**. Agregas y gestionas conexiones
desde el panel de detalle de un nodo (ver abajo). Los tipos de relación son:

- **Corre sobre** — este nodo es alojado o ejecutado por otro (una VM *corre sobre* un host). Un
  nodo tiene **un host activo a la vez**: si lo conectas a un nuevo host, lazyit cierra
  automáticamente el *corre sobre* anterior y abre el nuevo, así una máquina que se mueve entre hosts
  deja un historial limpio.
- **Miembro de** — este nodo pertenece a un grupo lógico (un host *es miembro de* un clúster).
- **Depende de** — este nodo necesita a otro para funcionar.
- **Respalda a** — los datos de este nodo se respaldan en otro (una VM *respalda a* el NAS).
- **Conecta con** — adyacencia de red simple. Esta es **simétrica** — conectar A con B es lo mismo
  que conectar B con A, y lazyit la guarda una sola vez en cualquier caso.

Cuando agregas una conexión, este nodo siempre es el *origen* y eliges el otro nodo como destino; el
panel te recuerda la dirección. lazyit avisa con suavidad si una combinación parece inusual (por
ejemplo un contenedor que *corre sobre* un dispositivo de red) pero no la bloquea — el modelo se
mantiene genérico. Si una conexión rompiera la regla de "un host activo" (o duplicara un vínculo
existente), recibirás un mensaje claro que explica por qué.

### Leer las líneas

En el mapa cada tipo de relación se dibuja para que las distingas de un vistazo — no solo por color,
sino por **color, estilo de línea y punta de flecha** juntos: *corre sobre* y *miembro de* son
sólidas (miembro-de un poco más gruesa, la columna de agrupación), *depende de* es discontinua con
una animación que fluye suavemente señalando la dirección de la dependencia, *respalda a* es punteada
y la simétrica *conecta con* es una línea fina y simple, sin flecha. Al pasar el cursor o seleccionar
una línea aparece una pequeña etiqueta con el nombre de la relación. Una **referencia de conexiones**
plegable, en la esquina inferior izquierda, asocia cada tipo a su color y estilo — ábrela cuando
necesites recordarlo. Pasar el cursor sobre un nodo también lo **destaca**: el resto del mapa se
atenúa para que veas de un vistazo con qué está conectado ese nodo.

## Estado

Cada nodo lleva un estado, mostrado como una píldora de color en su tarjeta y como insignia en el
panel:

- **En línea** — activo y alcanzable.
- **Fuera de línea** — caído.
- **Desconocido** — no establecido (el valor por defecto de un nodo nuevo).

Con el permiso de gestión defines el estado desde el panel de detalle. (El estado se fija a mano hoy;
la detección automática de actividad es una incorporación futura.)

## Quitar un nodo del mapa

Quitar un nodo es un **borrado suave**: sale del mapa pero su historial se conserva. Usa **Quitar
del mapa** en el panel de detalle y confirma. Nada se destruye — el nodo (y el activo detrás de él,
si lo hay) puede recuperarse más tarde. lazyit nunca borra de forma definitiva estos datos.

## El panel de detalle

Al hacer clic en un nodo se abre un panel a la derecha — la razón por la que esto supera a un dibujo
estático. Reúne, en un solo lugar:

> **Editar desde el panel.** Con el permiso de gestión, la sección **Detalles** del panel (cerca de
> arriba) se edita ahí mismo — sin una página aparte. Hacé clic en el **título** para renombrar el
> nodo; cambiá su **tipo** o su **dirección IP** directamente; y el **estado** y los **accesos
> directos** también son editables (ver abajo). Los cambios se guardan a medida que los hacés y la
> tarjeta del nodo en el lienzo se actualiza al instante. Quien solo puede ver lo encuentra como
> texto plano, sin controles de edición.

- **Responsable(s)** — quién es responsable, tomado de las asignaciones del activo vinculado. Un
  responsable que dejó la empresa pero cuya asignación nunca se liberó sigue mostrándose, marcado
  como tal.
- **Artículos de la base de conocimiento** — artículos publicados vinculados al activo del nodo,
  cada uno a un clic.
- **Referencias de secretos** — *solo identificadores, nunca los valores de los secretos.* Una
  referencia muestra el identificador `{{ lazyit_secret.… }}` y una etiqueta para que sepas qué
  credencial corresponde a esta máquina; aquí no hay forma de revelarlo y lazyit nunca expone el
  valor en esta superficie. Con el permiso de gestión vinculás una referencia desde el selector
  **Vincular un secreto** — lista solo los secretos **a los que tenés acceso** (las bóvedas de las
  que sos miembro) y elegís uno por su identificador; la **×** junto a una referencia la quita. Las
  referencias se guardan por identificador y se resuelven en vivo, así que la etiqueta siempre refleja
  el secreto actual; y si el secreto se elimina (o su identificador cambia) la referencia simplemente
  desaparece de la lista.
- **Accesos directos** — enlaces rápidos (SSH, interfaz web, consola) que se abren en una pestaña
  nueva. Con el permiso de gestión los editás ahí mismo: cada acceso directo es un par etiqueta + URL
  que podés cambiar, agregar o quitar, y luego **Guardás** la lista (lazyit verifica que cada URL sea
  válida antes de guardar).
- **Dirección IP** y fecha de **agregado**.
- **Hijos** — los nodos alojados en este (sus relaciones *corre sobre* activas).
- **Conexiones** — las relaciones activas de este nodo (que se pueden cerrar) y su historial cerrado
  (una migración de *corre sobre* aparece aquí), además de la acción **Agregar conexión**.

Una fila de la [Lista de servidores](/help/assets-topology-servers) enlaza directamente a este
panel, así puedes saltar de la tabla a la imagen completa de una máquina con un clic.

## Impacto / radio de afectación

La pregunta estrella que un mapa puede responder y un dibujo no: **"si este nodo se cae, ¿qué se ve
afectado?"** En el panel de detalle, activa **Mostrar impacto** para resaltar el conjunto aguas
abajo — cada nodo que corre sobre, depende de, o es miembro de este (directa o transitivamente). Por
eso, dar de baja un clúster o grupo también muestra sus miembros. El lienzo atenúa todo lo que queda
fuera del radio para que la región afectada destaque, y el panel lista cada nodo afectado con a
cuántos saltos de distancia está.

El impacto es una **estimación derivada de las aristas**, no una garantía verificada a mano — sigue
las aristas que dibujaste, así que un miembro podría sobrevivir si el grupo pierde un solo nodo. Los
enlaces de destino de respaldo y los puramente de red se ignoran a propósito: que falle un destino de
respaldo no tumba al primario, y una conexión de red simple no tiene dirección de fallo.

Un **resultado vacío es buena noticia** — significa que nada depende de este nodo, así que es seguro
darlo de baja. lazyit lo muestra como tranquilidad, no como un error.

## Qué sigue

- [Lista de servidores](/help/assets-topology-servers) — el mismo parque como tabla filtrable.
- [Conceptos de activos](/help/assets-asset-basics) — el registro de inventario detrás de un nodo respaldado por un activo.
- [Asignaciones e historial](/help/assets-assignments-history) — cómo funciona la propiedad (el responsable del panel).
