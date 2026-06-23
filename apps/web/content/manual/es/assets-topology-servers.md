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

> La lista muestra las mismas cosas a todos los que pueden ver la topología. Aquí es de solo
> lectura: crear, editar y conectar nodos sucede en el [Mapa](/help/assets-topology-diagram).

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
- **Activo** — si el nodo está **Rastreado** (respaldado por un activo) o es **Solo de grafo**. Esta
  columna muestra el *vínculo*, no el nombre del activo: el nombre completo del activo vinculado y sus
  responsables están a un clic en el panel de detalle.
- **IP** — la dirección IP principal del nodo, cuando está definida.

## Buscar y filtrar

- La **búsqueda** coincide con el **nombre** y la **IP** a medida que escribes.
- Los desplegables **Tipo**, **Estado** y **Estado de ciclo** acotan la lista. *Estado de ciclo*
  distingue los nodos confirmados de los pendientes (los pendientes son parte de una futura función
  de detección automática; hoy todo está confirmado).

Los filtros activos aparecen como chips removibles debajo de la barra de herramientas, y una acción
**Limpiar** los restablece todos.

## Abrir un servidor

Al hacer clic en una fila se pasa al Mapa y se abre el nodo en su panel de detalle — la imagen
completa: responsable, artículos de la base de conocimiento vinculados, referencias de secretos (solo
identificadores), accesos directos, conexiones y el interruptor de impacto/radio de afectación. Ver
[Diagrama de infraestructura](/help/assets-topology-diagram) para lo que cubre el panel.

## Qué sigue

- [Diagrama de infraestructura](/help/assets-topology-diagram) — el mismo parque como mapa de movimiento libre.
- [Conceptos de activos](/help/assets-asset-basics) — el registro de inventario detrás de un nodo respaldado por un activo.
