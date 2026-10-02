---
title: Recibir stock
category: assets
subcategory: asset-basics
order: 2
---

# Recibir stock

Cuando llega un envío de equipos idénticos — veinte laptops iguales, una caja de monitores — no hace
falta completar el formulario de activo veinte veces. **Recibir stock** crea muchos activos a partir de
un solo modelo en un paso, aplicando los mismos datos compartidos a cada unidad y dándole a cada una su
propio registro.

Se accede desde la lista de **Activos**: elige **Recibir stock** arriba a la derecha (necesitas permiso
para crear activos). Se abre un formulario breve.

## Qué completas

- **Modelo** (obligatorio) — el único modelo a partir del cual se crea cada unidad. Su nombre inicializa
  el nombre por defecto de cada unidad, y su categoría y especificaciones por defecto se incluyen igual
  que en el formulario de un solo activo. Si el modelo todavía no existe, créalo desde aquí mismo —
  ver más abajo.
- **Cantidad** (obligatorio) — cuántas unidades crear, desde 1 hasta el máximo por solicitud.
- **Estado** — el estado en el que arranca cada unidad (por ejemplo *Operativo* o *En almacén*).
- **Ubicación**, **Empresa**, **Fecha de compra**, **Costo de compra**, **Notas** — datos compartidos
  opcionales aplicados a **cada** unidad. El costo de compra se ingresa por unidad, en unidades
  mayores y con el formato de números de tu idioma, y la empresa sugiere los valores ya en uso — ambos
  igual que en el formulario de activo (ver [Conceptos de activos](/help/assets-asset-basics)).
- **Números de serie** — opcional. Pega un número de serie por línea, en orden, y cada unidad recibe el
  suyo. Déjalo vacío para crear unidades sin número de serie, o pega **exactamente** tantas líneas como
  la cantidad — un conteo que no coincide se rechaza antes de crear nada.

Las etiquetas de activo automáticas siguen aplicando: si tu instancia usa un
[esquema de etiquetas](/help/configuration-asset-tag-scheme), cada unidad se etiqueta automáticamente a
medida que se crea.

## Crear el modelo sin salir del formulario

La mayoría de los envíos llegan *porque* se compró algo nuevo, así que muchas veces el modelo que
necesitas todavía no existe. Usa el **+** que está junto al selector de modelo: abre un diálogo
**Nuevo modelo** encima del formulario.

- Solo aparece si tienes permiso para gestionar modelos. Sin ese permiso, elige entre los modelos
  existentes.
- Un modelo necesita **nombre** y **fabricante**. Si ya habías escrito un término de búsqueda en el
  selector, el nombre viene precargado con él — así no creas un casi-duplicado de un modelo que
  simplemente estaba escrito distinto.
- La **categoría es opcional** y solo puedes elegir una que ya exista. Crear una categoría aquí no se
  ofrece a propósito: un error de tipeo dejaría una categoría fantasma. Agrega categorías desde
  [modelos y categorías](/help/assets-models-categories) cuando necesites una nueva.
- Al pulsar **Crear**, el diálogo se cierra, el modelo nuevo queda seleccionado y **todo lo que ya
  habías escrito — cantidad, estado, ubicación, números de serie — sigue ahí.** Cancelar o presionar
  Escape cierra únicamente ese diálogo y no cambia nada del formulario.

El modelo es un registro por derecho propio: una vez creado queda en tu catálogo y es reutilizable,
incluso si después cancelas la recepción o la recepción falla.

## El éxito parcial es normal

Cada unidad se crea de forma **individual** — su propio registro, su propia etiqueta. Eso significa que
una recepción puede tener éxito **parcial**: la mayoría de las unidades se crean mientras algunas
fallan, casi siempre porque un número de serie pegado choca con uno que ya existe. Esto es intencional,
no un error.

Cuando termina la recepción, lazyit te muestra el resultado:

- **Cuántos activos se crearon** — ya están en tu inventario.
- **Una lista de las unidades que no se pudieron crear**, cada una con su posición en el lote y el
  motivo (por ejemplo un número de serie duplicado). Corrígelas y recíbelas de nuevo por separado.

Incluso si fallan **todas** las unidades, se informa como un resultado para leer — no como una solicitud
perdida. Nada de lo que veas en el conteo de "creados" se revierte por una falla posterior del mismo
lote.

Desde el resultado puedes ir directamente a los nuevos activos (el inventario filtrado por ese modelo),
**recibir más** o cerrar.

## Recibir contra una compra

Si registras [compras](/help/purchases-recording-purchases), las unidades de una entrega se pueden recibir
**contra su línea de compra**: quedan vinculadas a ella, cuentan como recibidas y toman los valores de la
compra sin volver a escribirlos. Hay tres caminos:

- **Desde una compra**, arriba de este formulario, lista las líneas que todavía esperan unidades. Elige
  una y el formulario pasa a esa línea, completado desde la compra.
- Cuando eliges un **modelo** que una compra abierta está esperando, una pista discreta bajo el modelo te
  ofrece **recibir contra ella**.
- En la propia compra, **Recibir** en la línea abre este mismo formulario ya completado.

Contra una línea, los números de serie van primero y la **cantidad los sigue**; los valores de la compra
se muestran como un resumen que puedes **Cambiar** solo para esta recepción. Los detalles están en
[Compras — Recibir unidades](/help/purchases-recording-purchases#recibir-unidades). El formulario de
**Nuevo activo** ofrece el mismo selector *Desde una compra*: elegir una línea abre este formulario para
ella.

Estas opciones aparecen solo si puedes ver y editar compras, y solo mientras alguna compra espera
unidades.

## Cuándo usar la importación en su lugar

Recibir stock es para unidades **nuevas** de un **único** modelo — uno que ya tienes, o uno que creas
en el momento desde el propio formulario. Para cargar un inventario
**existente** desde una planilla o una herramienta previa — muchos modelos distintos, con sus propios
números de serie y responsables — usa el [importador masivo](/help/assets-bulk-import) en su lugar.

## Qué sigue

- [Conceptos básicos de activos](/help/assets-asset-basics) — el formulario de un activo y todo lo que
  contiene.
- [Asignaciones e historial](/help/assets-assignments-history) — entrega un activo recibido a su
  responsable.
