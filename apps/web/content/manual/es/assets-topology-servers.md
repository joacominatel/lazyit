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
**Activos › Topología** y luego cambias con el interruptor **Mapa ⇄ Tabla** arriba a la derecha
(junto a **Agregar nodo**). La Tabla también está disponible directamente en
`/assets/diagram?view=table`.

Es útil cuando quieres *encontrar* una máquina en vez de *ver* cómo se conecta: recorre una columna,
filtra por un tipo o busca por nombre.

> La lista muestra las mismas cosas a todos los que pueden ver la topología. Crear, editar y conectar
> nodos sucede en el [Mapa](/help/assets-topology-diagram); la vista de Servidores agrega dos cosas
> propias — la bandeja de **Revisión pendiente** y el botón **Agregar un servidor** (ambos abajo).

## Cambiar entre Mapa y Tabla

El interruptor **Mapa ⇄ Tabla** está en el encabezado de Topología. Al cambiar de vista se conserva
tu contexto: la búsqueda y los filtros de la tabla (Tipo, Estado, Estado de ciclo) y cualquier nodo
que tengas seleccionado se mantienen, así que al pasar al Mapa ves el mismo parque — y al hacer clic
en una fila de la Tabla ese nodo se abre directamente en el Mapa.

## Columnas

Cada fila es un nodo:

- **Nombre** — el nombre del nodo; haz clic para abrir su detalle en el Mapa.
- **Tipo** — host, VM, contenedor, clúster, etc.
- **Estado** — En línea, Fuera de línea o Desconocido, como insignia de color.
- **Activo** — el nombre del activo de inventario vinculado cuando el nodo está respaldado por un
  activo, o **Solo de grafo** cuando no lo está. (El nombre se oculta si el activo vinculado se archivó.)
- **Responsable** — el o los responsables actuales del activo. Si hay más de uno, se muestra el
  primero más una pista "+N más"; la lista completa está en el panel de detalle. Quien dejó la empresa
  aparece tachado.
- **IP** — la dirección IP principal del nodo, cuando está definida.

## Buscar y filtrar

- La **búsqueda** coincide con el **nombre**, la **IP**, el **nombre del activo** vinculado y el
  **responsable** a medida que escribes.
- Los desplegables **Tipo**, **Estado** y **Estado de ciclo** acotan la lista. *Estado de ciclo*
  distingue los nodos **confirmados** de los **pendientes** — los pendientes son servidores que
  descubrió el [agente de reporte](/help/assets-topology-reporting-agent) y que esperan tu aprobación
  (ver *Revisión pendiente* abajo).

Los filtros activos aparecen como chips removibles debajo de la barra de herramientas, y una acción
**Limpiar** los restablece todos.

## Revisión pendiente

Cuando el [agente de reporte](/help/assets-topology-reporting-agent) descubre un servidor, no entra
directo a tu inventario: aparece en la bandeja de **Revisión pendiente** arriba de esta vista (visible
solo para quienes pueden gestionar la topología). Cada servidor pendiente muestra su nombre de host,
tipo, de dónde vino el reporte y hace cuánto reportó, con dos acciones: **Confirmar** para sumarlo a
tu topología activa (creando opcionalmente un activo registrado) o **Descartar** para soltar la
propuesta. Ver [Agente de reporte](/help/assets-topology-reporting-agent) para el flujo completo.

## Agregar un servidor

El botón **Agregar un servidor** (arriba de esta vista, para quienes pueden gestionar la
configuración) genera el comando de instalación de un solo uso del agente de reporte para que un
servidor Linux nuevo empiece a reportarse. Ver
[Agente de reporte](/help/assets-topology-reporting-agent).

## Abrir un servidor

Al hacer clic en una fila se pasa al Mapa y se abre el nodo en su panel de detalle — la imagen
completa: responsable, artículos de la base de conocimiento vinculados, referencias de secretos (solo
identificadores), accesos directos, conexiones y el interruptor de impacto/radio de afectación. Ver
[Diagrama de infraestructura](/help/assets-topology-diagram) para lo que cubre el panel.

## Qué sigue

- [Diagrama de infraestructura](/help/assets-topology-diagram) — el mismo parque como mapa de movimiento libre.
- [Agente de reporte](/help/assets-topology-reporting-agent) — descubrí servidores en la bandeja de arriba.
- [Conceptos de activos](/help/assets-asset-basics) — el registro de inventario detrás de un nodo respaldado por un activo.
