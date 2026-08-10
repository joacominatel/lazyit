---
title: Lista de servidores (vista Tabla)
category: assets
subcategory: topology
order: 2
---

# Lista de servidores (vista Tabla)

La vista **Tabla** es la forma de tabla, escaneable, de tu topología — los mismos nodos que el
[Mapa](/help/assets-topology-diagram), pero como una lista plana que puedes buscar y filtrar en lugar
de un mapa de movimiento libre. No es una entrada aparte en la barra lateral: la abres desde
**Activos › Topología** y luego cambias con el interruptor **Mapa · Tabla · Agentes** arriba a la
derecha (junto a **Agregar**). La Tabla también está disponible directamente en
`/assets/diagram?view=table`.

Es útil cuando quieres *encontrar* una máquina en vez de *ver* cómo se conecta: recorre una columna,
filtra por un tipo o busca por nombre.

> La lista muestra las mismas cosas a todos los que pueden ver la topología. Crear, editar y conectar
> nodos sucede en el [Mapa](/help/assets-topology-diagram); la vista de Servidores agrega lo suyo:
> la bandeja de **Revisión pendiente** (abajo).

## Cambiar entre Mapa, Tabla y Agentes

El interruptor **Mapa · Tabla · Agentes** está en el encabezado de Topología. Al cambiar de vista se
conserva tu contexto: la búsqueda y los filtros de la tabla (Tipo, Estado, Estado de ciclo) y
cualquier nodo que tengas seleccionado se mantienen, así que al pasar al Mapa ves el mismo parque — y
al hacer clic en una fila de la Tabla ese nodo se abre directamente en el Mapa.

La tercera vista, **Agentes**, no habla del grafo sino de las máquinas que se reportan solas: qué
versiones de agente estás corriendo, quién dejó de reportar y el comando que actualiza un host que
quedó atrasado. Ver
[la vista Agentes](/help/assets-topology-reporting-agent#la-vista-agentes).

## Columnas

Cada fila es un nodo. **Hacé clic en el encabezado de una columna para ordenar por ella**: Nombre,
Tipo, Estado e IP se pueden ordenar, y si volvés a hacer clic en el mismo encabezado se invierte entre
ascendente y descendente. El orden lo aplica lazyit sobre **todo** tu parque, no solo sobre las filas
de la página actual, así que ordenar por Nombre e ir a la última página te deja de verdad en el último
nombre alfabético.

- **Nombre** — el nombre del nodo; hacé clic para abrir su detalle en el Mapa. Se puede ordenar.
- **Tipo** — host, VM, contenedor, clúster, etc. Se puede ordenar.
- **Estado** — En línea, Fuera de línea o Desconocido, como insignia de color. Se puede ordenar.
- **Activo** — el nombre del activo de inventario vinculado cuando el nodo está respaldado por un
  activo, o **Solo de grafo** cuando no lo está. (El nombre se oculta si el activo vinculado se archivó.)
- **Responsable** — el o los responsables actuales del activo. Si hay más de uno, se muestra el
  primero más una pista "+N más"; la lista completa está en la ventana de detalle. Quien dejó la
  empresa
  aparece tachado.
- **IP** — la dirección IP principal del nodo, cuando está definida. Se puede ordenar.

**Activo y Responsable no se pueden ordenar**, y es a propósito: ninguno de los dos pertenece al
servidor en sí. Los dos se leen del *activo de inventario vinculado* —uno de ellos a través de su
asignación vigente—, así que no hay una columna del servidor por la cual ordenar. Ordená por Nombre si
querés agruparlos de forma previsible.

## Buscar y filtrar

- La **búsqueda** coincide con el **nombre**, la **IP**, el **nombre del activo** vinculado y el
  **responsable** (nombre o correo) a medida que escribís. La búsqueda recorre **todo tu parque**, no
  solo la página que estás mirando: una máquina que está en la página cuatro se encuentra desde la
  página uno, y "sin resultados" significa de verdad que no hay resultados.
- Los desplegables **Tipo**, **Estado** y **Estado de ciclo** acotan la lista. *Estado de ciclo*
  distingue los nodos **confirmados** de los **pendientes** — los pendientes son servidores que
  descubrió el [agente de reporte](/help/assets-topology-reporting-agent) y que esperan tu aprobación
  (ver *Revisión pendiente* abajo).

Los filtros activos aparecen como chips removibles debajo de la barra de herramientas, y una acción
**Limpiar** los restablece todos.

## Recorrer la lista por páginas

La tabla muestra una página por vez, con los **controles de paginación abajo**: cuántas filas estás
viendo, sobre cuántas coinciden, y los botones para pasar de una página a otra.

Ese número es el de lo que pidieron tu **búsqueda y tus filtros**, no el de todo tu parque: con un
filtro de Tipo activo, "1–50 de 118" significa 118 nodos de ese tipo, y pasando las páginas los
recorrés a los 118. La búsqueda, los filtros y el orden los aplica lazyit *antes* de cortar la página,
así que cambiar cualquiera de ellos vuelve a cortar las páginas y te devuelve a la primera. La página,
la búsqueda, los filtros y el orden viven en la URL, así que la vista sobrevive a una recarga y podés
compartirla o guardarla tal como está.

> [!NOTE]
> Antes la lista cargaba todos los nodos de una y los buscaba en tu navegador. Ya no: un parque puede
> crecer rápido —un solo hipervisor puede sumar cientos de máquinas virtuales en un mismo reporte, ver
> [Hosts hipervisores](/help/assets-topology-hypervisors)— y una búsqueda que solo cubriera lo
> que estaba cargado se saltearía máquinas sin avisar.

## Revisión pendiente

Cuando el [agente de reporte](/help/assets-topology-reporting-agent) descubre un servidor, no entra
directo a tu inventario: aparece en la bandeja de **Revisión pendiente** arriba de esta vista (visible
solo para quienes pueden gestionar la topología). Cada servidor pendiente muestra su nombre de host,
tipo, de dónde vino el reporte y hace cuánto reportó, con dos acciones: **Confirmar** para sumarlo a
tu topología activa (creando opcionalmente un activo registrado) o **Descartar** para soltar la
propuesta. Ver [Agente de reporte](/help/assets-topology-reporting-agent) para el flujo completo.

El número que aparece junto a **Revisión pendiente** es el de **toda la cola**, y la bandeja la
trabaja de a **200**, los descubiertos más recientemente primero. Cuando hay más que eso te lo dice
arriba de las filas —*"Se muestran 200 de 431 nodos pendientes"*— y al confirmar o descartar esa
tanda aparece la siguiente. La bandeja queda vacía solo cuando la cola lo está.

## Agregar un servidor

Usá **Agregar › Instalar un agente de reporte** en el encabezado de la página (visible en ambas
vistas para quienes pueden gestionar la configuración) para generar el comando de instalación de un
solo uso del agente de reporte —para un host **Linux o Windows**, el que elijas— para que un servidor
nuevo empiece a reportarse. Hasta que tengas tu primer agente, esta vista además encabeza con una
tarjeta **Creá tu primer agente** que explica qué es uno. Ver
[Agente de reporte](/help/assets-topology-reporting-agent).

## Abrir un servidor

Al hacer clic en una fila se pasa al Mapa y se abre la ventana de detalle del nodo — la imagen
completa: responsable, artículos de la base de conocimiento vinculados, referencias de secretos (solo
identificadores), accesos directos, conexiones, el hardware y el software reportados, y el historial
de cambios. Ver [Diagrama de infraestructura](/help/assets-topology-diagram) para lo que cubre cada
pestaña. El interruptor de impacto/radio de afectación vive en el mapa mismo, en la barra de acciones
del nodo seleccionado.

## Qué sigue

- [Diagrama de infraestructura](/help/assets-topology-diagram) — el mismo parque como mapa de movimiento libre.
- [Agente de reporte](/help/assets-topology-reporting-agent) — descubrí servidores en la bandeja de arriba.
- [Conceptos de activos](/help/assets-asset-basics) — el registro de inventario detrás de un nodo respaldado por un activo.
