---
title: Búsqueda global
order: 1
category: notifications-activity
subcategory: global-search
---

# Búsqueda global

La búsqueda global es la paleta de comandos que abarca todo el producto: una sola caja que busca a la
vez en activos, artículos, usuarios, ubicaciones, aplicaciones, nodos de topología y consumibles.
Tolera errores de tipeo y ordena los resultados por relevancia, así que una palabra parcial o casi
acertada igual encuentra el registro.

## Cómo abrirla

- Pulsa **⌘K** (macOS) o **Ctrl+K** (Windows / Linux) desde cualquier parte de la app, **o**
- Haz clic en la **caja de búsqueda** de la barra superior.

Empieza a escribir y los resultados aparecen, agrupados por tipo. Recórrelos con las flechas **↑ / ↓**,
pulsa **Enter** para abrir el resultado resaltado y **Esc** para cerrar.

## Qué busca

Se indexan siete tipos de registros:

- **Activos** — por nombre, etiqueta de activo o número de serie.
- **Artículos** — artículos de la Base de Conocimiento, incluido su cuerpo de texto, así que un
  procedimiento dentro de un artículo es localizable. Solo se buscan artículos publicados; los
  borradores nunca aparecen.
- **Usuarios** — por nombre y correo.
- **Ubicaciones** — por nombre y dirección.
- **Aplicaciones** — por nombre y proveedor.
- **Nodos de topología** — servidores, máquinas virtuales, contenedores y el resto del mapa de
  infraestructura, por etiqueta, dirección IP o nombre del activo vinculado.
- **Consumibles** — repuestos y artículos de stock, por nombre, SKU o descripción. La vista previa
  muestra cuánto queda en existencia, así que "¿cuántos cables HDMI quedan?" se responde en la paleta.

Usa las **fichas de filtro** encima de los resultados para acotar la búsqueda a un solo tipo, o déjala en
**Todos** para buscar en todo. Al seleccionar un resultado se navega directamente a ese registro.

## Vista rápida — previsualiza un resultado sin salir de la búsqueda

Cada fila de resultado lleva un pequeño **ojo** que aparece al pasar el cursor por la fila (o cuando la
selección del teclado cae sobre ella). Pasa el cursor por el ojo para asomarte a una **vista previa**
generosa de ese registro, o haz clic para **fijarla** abierta. Las vistas previas fijadas muestran un
enlace **"Abrir ficha completa"** que abre la entidad en una pestaña nueva, así puedes confirmar que
tienes al "Juan D." correcto o el `LZ-0042` correcto antes de navegar.

Solo hay una vista previa abierta a la vez, y **Esc** la cierra (devolviendo el foco al cuadro de
búsqueda). Para abrir una vista previa **desde el teclado**, resaltá un resultado con las flechas
**↑ / ↓** y presioná **Alt + Enter** — abre y fija la vista previa de ese resultado sin navegar, y el
pie la lista junto a los demás atajos. La mayoría de las vistas previas se renderizan al instante a
partir del propio resultado de búsqueda; los detalles más ricos de un activo o un usuario (responsable,
ubicación, rol) se cargan a pedido en el momento en que abres la vista previa, así que abrirla nunca
ralentiza la búsqueda.

## Lo que ves depende de tus permisos

Los resultados de la búsqueda respetan el control de acceso:

- Los **usuarios** se excluyen de la búsqueda para quien no pueda leer el directorio de personas (un
  Visor por defecto), de modo que la búsqueda nunca se vuelve una puerta trasera para enumerar nombres y
  correos.
- Los **artículos** se filtran a las carpetas que realmente puedes abrir, así que un artículo restringido
  nunca aparece para alguien que de otro modo no podría leerlo.

Por eso dos personas pueden obtener resultados distintos para la misma consulta — por diseño.

## Cuando la búsqueda no está disponible

La búsqueda funciona con un servicio de búsqueda aparte, y es deliberadamente **tolerante a fallos**: si
ese servicio está caído, el resto de lazyit sigue funcionando y la paleta muestra un mensaje claro de
"búsqueda no disponible" en vez de fingir que no hay resultados. Vuelve a intentarlo cuando el servicio
esté de vuelta.

## Mantener el índice al día

El índice de búsqueda se actualiza automáticamente a medida que los registros se crean, editan y
eliminan. Dos situaciones piden una reconstrucción manual:

- **Tras el primer despliegue**, para poblar el índice a partir de la base de datos existente.
- **Tras una caída del servicio de búsqueda**, para reparar cualquier desfase (por ejemplo, una
  eliminación que no llegó al índice mientras estaba fuera de línea).

Un operador reconstruye todos los índices ejecutando `reindex:all` desde la API (`bun run reindex:all`).
Es una reconstrucción autoritativa y sin tiempo de inactividad: carga exactamente el conjunto vivo y
visible en un índice nuevo y lo intercambia, expulsando cualquier entrada obsoleta, mientras la búsqueda
sigue sirviendo el índice anterior hasta que el intercambio termina. La Base de Conocimiento en
particular necesita esta ejecución tras un despliegue nuevo, o la búsqueda de artículos no devuelve nada
hasta que se haga.
