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
**Mapa · Tabla · Agentes** arriba a la derecha: el **Mapa** es este tablero de movimiento libre, la
**Tabla** es una lista plana y filtrable de los mismos nodos — ver
[Lista de servidores](/help/assets-topology-servers) — y **Agentes** es la vista de flota de las
máquinas que se reportan solas, con el comando que actualiza las que quedaron atrasadas
([Agente de reporte](/help/assets-topology-reporting-agent#la-vista-agentes)).

> Cualquiera que pueda ver la topología ve el mapa y el detalle de solo lectura de cada nodo.
> Agregar nodos, dibujar conexiones, cambiar un estado o quitar un nodo del mapa requiere el permiso
> de gestión de topología; instalar un agente de reporte requiere en cambio el de gestión de
> configuración —un permiso aparte, no un agregado—, porque genera un token. Sin un permiso, sus
> controles simplemente no aparecen.

## Las notebooks y los equipos de escritorio se mantienen fuera del mapa

**Si tu mapa se achicó, no se borró nada.** lazyit mantiene fuera del diagrama, por defecto, las
**notebooks y los equipos de escritorio** reportados. Cuando hay alguno, aparece un botón en la
esquina superior derecha del tablero que dice exactamente cuántos son — *Mostrar 142 equipos de
usuario*. Al hacer clic aparecen todos; con *Ocultar 142 equipos de usuario* se van de nuevo. La
elección queda en la dirección de la página, así que sobrevive a una recarga, al botón Atrás del
navegador y a cambiar a la Tabla y volver.

**Por qué.** Un parque típico tiene un par de decenas de servidores y un par de *cientos* de puestos
de trabajo. Dibujarlos todos convierte el mapa en una pared de cajas con la infraestructura enterrada
en algún lugar adentro — y la topología del parque es justamente lo que viniste a leer acá. Cada
máquina sigue perteneciendo a lazyit; simplemente no pertenece a esta imagen en particular por
defecto.

**Nada salió de tu inventario.** Una máquina oculta sigue estando exactamente igual de presente que
antes:

- está en la [lista de servidores](/help/assets-topology-servers), que **muestra todo, siempre** —
  esta ocultación es solo del mapa,
- está en la búsqueda, en tu inventario de activos y en cada informe,
- sigue contando en un [radio de afectación](#impacto--radio-de-afectación): si un servidor se cae y
  una notebook oculta depende de él, esa notebook sigue estando en la respuesta,
- su propia ventana de detalle se abre como siempre.

Ocultar es una decisión de **dibujo** sobre una sola pantalla, y no es nada más que eso.

**Solo se oculta una máquina que dice que lo es.** Cada agente de reporte le informa a lazyit el
**formato** del host, leído del firmware de la propia máquina: *notebook*, *equipo de escritorio*,
*servidor*, *máquina virtual*, *contenedor*. Solo los dos primeros salen del mapa. Todo lo demás se
queda, y también se queda todo lo que no dijo nada: un nodo que dibujaste a mano, un servidor con un
agente más viejo, una máquina cuyo hardware no reporta el formato, o una que simplemente no se
reportó desde que actualizaste. **lazyit nunca oculta una máquina por una suposición** — un host que
desapareciera de todas las pantallas sería mucho peor que un mapa cargado. Podés ver el formato de
cualquier nodo en la pestaña **General** de su ventana de detalle.

**Pasa de a poco, no de golpe.** En el momento de actualizar, el mapa es idéntico: ninguna máquina
reportó todavía su formato. Cada una lo completa en su próximo reporte, así que a lo largo de los
minutos siguientes los puestos de trabajo se van del tablero mientras los servidores se quedan. No
hay nada que ejecutar ni nada que configurar.

## El lienzo

El tablero es una superficie que se desplaza y hace zoom, con fondo punteado y un minimapa pequeño.
Arrastra un nodo para reubicarlo: la nueva posición se guarda automáticamente cuando termina el
arrastre, así que la disposición que armes es la que todos verán la próxima vez. Usa los controles
de la esquina (o tu trackpad/scroll) para hacer zoom y ajustar la vista.

La esquina superior derecha del tablero es donde viven sus controles: el botón **Mostrar/Ocultar
equipos de usuario** descrito arriba (lo ve todo el mundo) y —con el permiso de gestión— **Ordenar**.

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
**Al hacer clic en una tarjeta se selecciona** y aparece una pequeña barra de acciones debajo con dos
botones: **Mostrar radio de afectación** (lo vemos abajo; dibuja su respuesta sobre el mapa mismo) y
**Detalles**, que abre la ventana de detalle del nodo. Un doble clic sobre la tarjeta abre la ventana
de detalle directamente. El clic selecciona en lugar de abrir para que el mapa siga visible: la
ventana de detalle es grande, y taparlo en cada clic escondería justo lo que viniste a mirar.

## Agregar al mapa

Con los permisos correspondientes verás un botón **Agregar** en el encabezado de la página, con dos
caminos:

- **Instalar un agente de reporte** — el recomendado para un servidor. Obtienes un asistente guiado
  que crea las credenciales y te entrega un comando de instalación listo para pegar; a partir de ahí
  ese servidor completa por sí solo su hardware, su software y su estado, y se marca fuera de línea
  cuando deja de reportar. Ver [Agente de reporte](/help/assets-topology-reporting-agent). Requiere el
  permiso de gestión de configuración, porque genera un token.
- **Agregar un nodo a mano** — para lo que no puede ejecutar un agente (un switch, un firewall, un
  NAS), o para una máquina que simplemente quieres en el mapa ahora. Un nodo dibujado a mano lo
  mantienes actualizado tú. Requiere el permiso de gestión de topología.

Si solo tienes uno de los dos permisos, el botón es directamente ese camino. Si no tienes ninguno, no
hay botón: el mapa se lee igual, simplemente no es editable.

El botón **Agregar** también se repite en el centro de un mapa vacío, que es justo cuando lo
necesitas.

### Agregar un nodo a mano

El formulario pide lo justo para poner una cosa en el mapa:

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
aparece en el encabezado de la ventana de detalle como un *nombre de inventario* secundario, así que
ambos nunca se desfasan en silencio. Ese nombre de inventario es un **enlace de vuelta al activo**
—hacé clic para abrir su registro completo—. La propia página de detalle del activo cierra el
círculo en sentido contrario: muestra una insignia **En la topología** y un botón **Ver en la
topología** que vuela el mapa hasta este nodo (ver
[Conceptos básicos de activos](/help/assets-asset-basics)).

## Relaciones (conexiones)

Dos nodos se unen mediante una **conexión tipada y direccional**. Agregas y gestionas conexiones en
la pestaña **Conexiones** de la ventana de detalle de un nodo (ver abajo). Los tipos de relación
son:

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
formulario te recuerda la dirección. lazyit avisa con suavidad si una combinación parece inusual (por
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
encabezado de la ventana de detalle:

- **En línea** — activo y alcanzable.
- **Fuera de línea** — caído.
- **Desconocido** — no establecido (el valor por defecto de un nodo nuevo).

Con el permiso de gestión defines el estado en la pestaña **General** de la ventana de detalle. Los
nodos reportados por el
[agente de reporte](/help/assets-topology-reporting-agent) llevan su estado (y una insignia
*Reportado por agente* con una frescura "reportado hace …") automáticamente; igual podés fijarlo a
mano para los nodos que gestionás vos.

> **Nodos descubiertos automáticamente.** Los servidores reportados por el
> [agente de reporte](/help/assets-topology-reporting-agent) no aparecen en el mapa de inmediato:
> esperan en la bandeja de **Revisión pendiente** en la
> [lista de servidores](/help/assets-topology-servers) hasta que los confirmás.

## Quitar un nodo del mapa

Quitar un nodo es un **borrado suave**: sale del mapa pero su historial se conserva. Usa **Quitar
del mapa**, al final de la pestaña **General** de la ventana de detalle, y confirma. Nada se destruye
— el nodo (y el activo detrás de él, si lo hay) puede recuperarse más tarde. lazyit nunca borra de
forma definitiva estos datos.

## La ventana de detalle

Seleccioná un nodo y hacé clic en **Detalles** (o doble clic sobre el nodo) para abrir su ventana de
detalle — la razón por la que esto supera a un dibujo estático. Es una ventana grande con pestañas,
porque una máquina reportada por un agente lleva muchísimo más de lo que jamás llevó una tarjeta
dibujada a mano, y ponerlo todo en una sola columna obligaba a pasar de largo por todo para llegar a
una sola cosa.

**Las pestañas se adaptan al nodo.** Solo ves las que tienen algo que decir:

- **General** *(siempre)* — qué es este nodo y quién es responsable de él: tipo, dirección IP,
  **formato** (para hosts reportados por agente — lo que decide si se dibuja en el mapa por defecto),
  fecha de agregado, estado, responsable(s), artículos de la base de conocimiento, referencias de
  secretos y accesos directos, además de **Quitar del mapa**.
- **Datos reportados** *(solo nodos reportados por agente)* — lo que la máquina dice que es. Para un
  servidor: sistema operativo, kernel, CPU, memoria, fabricante/modelo/número de serie, y los discos
  e interfaces de red que encontró. Para un contenedor: su nombre, imagen, digest de la imagen, estado
  del runtime, id del contenedor y sus puertos publicados, en una tabla con espacio para leerla.
- **Software** *(solo servidores que reportan)* — la lista de paquetes instalados, con búsqueda y
  espacio propio. Los contenedores no reportan una, así que no tienen esta pestaña; tampoco la tiene
  un servidor del que lazyit no guarda ninguna lista — ver
  [Agente de reporte](/help/assets-topology-reporting-agent) para la diferencia entre "sin lista" y
  "una lista vacía".
- **Conexiones** *(siempre)* — con qué está enlazado este nodo: **Se ejecuta acá** (los nodos
  alojados en él) y sus relaciones activas (que se pueden cerrar) más su historial cerrado, con la
  acción **Agregar conexión**.
- **Cambios** *(siempre)* — qué se movió en este nodo a lo largo del tiempo. Ver
  [Agente de reporte](/help/assets-topology-reporting-agent).

> **Editar ahí mismo.** Con el permiso de gestión, el bloque **Detalles** de la pestaña **General**
> se edita ahí mismo — sin una página aparte. Hacé clic en el **título** del encabezado para
> renombrar el nodo; cambiá su **tipo**, su **dirección IP** o su **estado** directamente; y los
> **accesos directos** también son editables. Los cambios se guardan a medida que los hacés y la
> tarjeta del nodo en el lienzo se actualiza al instante. Quien solo puede ver lo encuentra como
> texto plano, sin controles de edición. La **dirección IP** se valida al guardarla: debe ser una
> dirección IPv4 o IPv6 válida, y una entrada inválida se rechaza con un mensaje claro en lugar de
> guardarse.

Algunas cosas de la pestaña **General** que vale la pena señalar:

- **Responsable(s)** — tomado de las asignaciones del activo vinculado. Un responsable que dejó la
  empresa pero cuya asignación nunca se liberó sigue mostrándose, marcado como tal.
- **Referencias de secretos** — *esta superficie guarda solo identificadores, nunca los valores de los
  secretos.* Una referencia muestra una etiqueta y un control de **revelar (el ojito)**. Si sos miembro
  de la bóveda del secreto podés revelar el valor acá mismo —igual que un chip de secreto de la KB—:
  hacés clic en el ojito, desbloqueás si te lo pide, y el valor se descifra **en tu navegador** (los
  servidores de lazyit nunca lo ven) y se vuelve a ocultar solo a los pocos segundos. Si **no** sos
  miembro ves un chip bloqueado y no se expone nada. Con el permiso de gestión vinculás una
  referencia desde el selector **Vincular un secreto** — lista solo los secretos **a los que tenés
  acceso** (las bóvedas de las que sos miembro) y elegís uno por su identificador; la **×** junto a
  una referencia la quita. Las referencias se guardan por identificador y se resuelven en vivo, así
  que la etiqueta siempre refleja el secreto actual; y si el secreto se elimina (o su identificador
  cambia) la referencia simplemente desaparece de la lista.
- **Accesos directos** — enlaces rápidos (SSH, interfaz web, consola) que se abren en una pestaña
  nueva. Con el permiso de gestión los editás ahí mismo: cada acceso directo es un par etiqueta + URL
  que podés cambiar, agregar o quitar, y luego **Guardás** la lista (lazyit verifica que cada URL sea
  válida antes de guardar).
- **Formato** — para un nodo reportado por un agente, lo que la máquina dice que es físicamente,
  leído de su firmware: *notebook*, *equipo de escritorio*, *servidor*, *máquina virtual* o
  *contenedor*. Se muestra, no se edita: el agente lo reescribe en cada reporte, así que una máquina
  reinstalada o con una placa nueva lo mantiene honesto por sí sola. También es lo que decide si el
  nodo se dibuja en el mapa por defecto (ver *Las notebooks y los equipos de escritorio se mantienen
  fuera del mapa* más arriba). Un nodo dibujado a mano no tiene ninguno, y una máquina que no reportó
  uno simplemente no muestra este campo.
- **IP duplicada** — si otro nodo del mapa ya tiene la *misma* IP exacta, un **aviso no bloqueante**
  lista el/los otro(s) nodo(s) — es un aviso, no un bloqueo: la dirección se guarda igual (lazyit no
  impone unicidad en las IP), y cada nodo listado está a un clic para que puedas saltar a él y
  resolverlo.
- **Posible duplicado en el inventario** — un segundo aviso no bloqueante, para máquinas que
  versiones anteriores de lazyit registraron dos veces. Si el activo de este nodo se creó
  automáticamente y no tiene número de serie, mientras que el serie que reporta la máquina pertenece
  a un activo *distinto*, lazyit lo dice y enlaza el otro activo para que vayas a mirarlo. **Es un
  aviso y nada más: lazyit nunca fusiona los dos por vos.** Combinar dos registros de inventario
  implica decidir qué pasa con dos conjuntos de asignaciones, historial, etiquetas y documentos
  adjuntos, y eso es un criterio humano, no algo que una actualización deba resolver mientras no
  estás mirando. Ver [Agente de reporte](/help/assets-topology-reporting-agent) para saber cómo se
  llegó a esa situación y qué evita que vuelva a pasar.

Una fila de la [Lista de servidores](/help/assets-topology-servers) enlaza directamente a esta
ventana, así puedes saltar de la tabla a la imagen completa de una máquina con un clic.

## Impacto / radio de afectación

La pregunta estrella que un mapa puede responder y un dibujo no: **"si este nodo se cae, ¿qué se ve
afectado?"** Seleccioná el nodo y hacé clic en **Mostrar radio de afectación** en su barra de
acciones: el control vive en el mapa, porque la respuesta se dibuja en el mapa. Se resalta cada nodo
que corre sobre, depende de, o es miembro de este (directa o transitivamente); por eso, dar de baja
un clúster o grupo también muestra sus miembros. El lienzo atenúa todo lo que queda fuera del radio
para que la región afectada destaque, y al pasar el cursor por cualquier nodo resaltado ves a cuántos
saltos de distancia está.

Un pequeño cartel abajo trae el resto de la respuesta: **cuántos** nodos quedan afectados y **cuáles**
—debajo del número se listan los nodos afectados, cada uno con su tipo y a cuántos saltos está, los
más cercanos primero—. La lista viene abierta y tiene su propio desplazamiento; el chevron al lado
del número la pliega cuando preferís ver todo el tablero, y **Ocultar radio de afectación** apaga
todo. El
resaltado te dice de un vistazo qué tan grave es; la lista es lo que se puede recorrer, contar o
copiar. Mientras el radio se está calculando el cartel lo dice, y si la consulta falla también lo
dice, con un botón **Reintentar**: una consulta que falló nunca se muestra como "nada depende de este
nodo".

El impacto es una **estimación derivada de las aristas**, no una garantía verificada a mano — sigue
las aristas que dibujaste, así que un miembro podría sobrevivir si el grupo pierde un solo nodo. Los
enlaces de destino de respaldo y los puramente de red se ignoran a propósito: que falle un destino de
respaldo no tumba al primario, y una conexión de red simple no tiene dirección de fallo.

Un **resultado vacío es buena noticia** — significa que nada depende de este nodo, así que es seguro
darlo de baja. lazyit lo muestra como tranquilidad, no como un error.

## Qué sigue

- [Lista de servidores](/help/assets-topology-servers) — el mismo parque como tabla filtrable.
- [Agente de reporte](/help/assets-topology-reporting-agent) — completá el mapa desde tus servidores.
- [Conceptos de activos](/help/assets-asset-basics) — el registro de inventario detrás de un nodo respaldado por un activo.
- [Asignaciones e historial](/help/assets-assignments-history) — cómo funciona la propiedad (el
  responsable de la pestaña General).
