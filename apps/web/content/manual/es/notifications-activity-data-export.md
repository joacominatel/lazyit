---
title: Exportar datos
order: 1
category: notifications-activity
subcategory: data-export
---

# Exportar datos

La mayoría de las listas de lazyit se pueden descargar como un archivo **CSV** que puedes abrir en una hoja
de cálculo, pasar a finanzas o procesar con un script. Busca el botón **Exportar CSV** arriba de la lista.

## Dónde puedes exportar

| Pantalla | Qué contiene el archivo |
| --- | --- |
| **Activos** | Una fila por activo: nombre, etiqueta, número de serie, estado, modelo, ubicación, empresa, fechas, responsables, notas, costo de compra y moneda. |
| **Informes** (actividad) | Una fila por evento: cuándo, acción, entidad, responsable y resumen. |
| **Informes → Registro de auditoría** | Una fila por evento de la pestaña de fuente que tengas abierta (Secretos, Permisos, Cuentas de servicio o Exportaciones). |
| **Usuarios** | Una fila por persona: nombre, correo, rol, si la cuenta está activa, datos del directorio, responsable directo, y cuántos activos y accesos tiene. |
| **La página de una aplicación** | Sus accesos, activos y revocados: quién, nivel de acceso, quién lo otorgó o revocó y cuándo, vencimiento y notas. El botón está en el panel *Acceso activo*. |
| **La página de una persona** | Las mismas columnas de accesos para esa persona, activos y revocados. El botón está en la pestaña *Accesos*. |
| **Consumibles** | Una fila por artículo: nombre, SKU, categoría, unidad, stock actual, umbral de reposición y si está bajo. |
| **Compras** | Una fila por compra: referencia, proveedor, estado, estado de recepción, fechas, números de factura, unidades pedidas, recibidas y pendientes, total y moneda. |
| **Compras → Unidades pendientes** | Una fila por línea que todavía espera unidades: compra, proveedor, fechas, tipo, modelo o descripción, y unidades pedidas, recibidas, canceladas y pendientes. |
| **Compras → Proveedores** | Una fila por proveedor: nombre, identificación fiscal, sitio web, contactos de ventas y de soporte, y notas. |
| **Aplicaciones** | Una fila por aplicación: nombre, fabricante, URL, criticidad, asientos comprados y usados, costo por asiento, fecha de renovación y notas. |
| **Solicitudes de acceso** | Las solicitudes pendientes de la cola de revisión: aplicación, solicitante, nivel de acceso, justificación y cuándo se pidió. |
| **Ubicaciones** | Una fila por ubicación: nombre, tipo, ubicación superior, dirección, piso, descripción y notas. |
| **Topología → Tabla** (servidores) | Una fila por nodo que coincide con los filtros: etiqueta, tipo, estado, ciclo (confirmado o pendiente), origen, dirección IP, activo vinculado y sus responsables, chasis, versión del agente y último reporte. |
| **La página de un consumible** | Sus movimientos de stock: fecha, tipo, cantidad, motivo, quién lo hizo y adónde fue una entrega. El botón está en el panel *Movimientos*. |
| **Consumibles entregados** (en la página de una persona, un activo o una ubicación) | Las entregas a esa persona, activo o ubicación con los filtros del panel: consumible, cantidad, fecha y si es retornable, está pendiente o se devolvió. |
| **Base de conocimiento** | El índice de artículos de la lista que estás viendo: título, carpeta, estado, autor, fechas, tiempo de lectura y cantidad de vínculos. |

El gestor de secretos tiene su propia exportación de los ítems de una bóveda, que funciona de otra forma:
mira [Bóvedas y miembros](/help/secret-manager-vaults-members).

Algunos archivos dejan afuera lo que no podías ver en pantalla:

- **Base de conocimiento**: el archivo contiene solo los *metadatos* de los artículos, nunca el texto.
  Lista solo los artículos que puedes abrir: las carpetas restringidas para ti quedan afuera, y un
  borrador aparece solo para su autor.
- **Entregas y movimientos**: un destino de entrega que no puedes ver (por ejemplo una persona, si no
  puedes ver usuarios) conserva solo su id, nunca su nombre.

## Qué entra en el archivo

Una exportación contiene **todas las filas que coinciden con los filtros que tienes puestos**: la búsqueda,
los filtros, la pestaña y la vista de archivados. Nunca es solo la página que tienes delante, e ignora el
tamaño de página, las columnas que elegiste mostrar y el orden en que ordenaste. Cada lista escribe siempre
las mismas columnas, con las filas más recientes primero, así un script que lee el archivo sigue
funcionando.

Para exportar una porción, filtra la lista primero y después exporta.

En **Aplicaciones**, los filtros de categoría y criticidad acotan solo la página en pantalla, así que la
exportación no puede seguirlos: el botón queda deshabilitado mientras alguno esté puesto. Quítalos para
exportar; el archivo sigue la búsqueda.

## Límites

- **100.000 filas por archivo.** Si la lista coincide con más, el botón te avisa antes de descargar nada, y
  la exportación se rechaza en lugar de cortarse. Acota los filtros (en Informes, lo habitual es un rango de
  fechas) y vuelve a intentarlo.
- **Una exportación a la vez, cinco por minuto.** Una segunda exportación mientras otra se sigue
  descargando, o una sexta dentro del mismo minuto, se rechaza con un mensaje que te pide esperar un
  momento.

## Quién puede exportar

Cualquiera que pueda ver una lista puede exportarla. No hay un permiso de exportación aparte. El archivo
sigue las mismas reglas que la pantalla: la vista de archivados sigue siendo solo para administradores, y en
**Activos** las columnas de proveedor, referencia de compra y números de factura solo aparecen para quien
puede ver las compras.

## Cada exportación queda registrada

Cada exportación se anota en el registro de auditoría, en **Informes → Registro de auditoría →
Exportaciones**: quién exportó, qué lista, cuántas filas y con qué filtros. La entrada se escribe cuando
empieza la descarga, así que una exportación que abandonas a medias también aparece. Una exportación
rechazada (demasiadas filas, o demasiadas a la vez) no se registra. Exportar la propia pestaña
*Exportaciones* incluye la entrada de esa misma exportación.

## Abrir el archivo en una hoja de cálculo

El archivo es UTF-8 con marca de orden de bytes, así que Excel muestra bien los nombres con tildes
(*José*, *Dirección*). Una celda de texto que empieza con `=`, `+`, `-` o `@` lleva delante un `'`, para que
la hoja de cálculo nunca la ejecute como fórmula. Los números y las fechas se escriben como valores
simples.

## El archivo de activos se puede volver a importar

El archivo de activos empieza con una línea como `# lazyit v2.1.0 — 2026-10-16T…` que indica la versión
que lo escribió. Conserva esa línea si editas el archivo para volver a cargarlo con la
[importación masiva](/help/assets-bulk-import): el importador la lee para comprobar que el archivo viene de
una versión compatible. Ninguna otra exportación la lleva, así que todos los demás archivos tienen los
nombres de sus columnas en la primera línea.
