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
  que en el formulario de un solo activo.
- **Cantidad** (obligatorio) — cuántas unidades crear, desde 1 hasta el máximo por solicitud.
- **Estado** — el estado en el que arranca cada unidad (por ejemplo *Operativo* o *En almacén*).
- **Ubicación**, **Empresa**, **Fecha de compra**, **Costo de compra**, **Notas** — datos compartidos
  opcionales aplicados a **cada** unidad. El costo de compra se ingresa por unidad, en unidades
  mayores, igual que en el formulario de activo.
- **Números de serie** — opcional. Pega un número de serie por línea, en orden, y cada unidad recibe el
  suyo. Déjalo vacío para crear unidades sin número de serie, o pega **exactamente** tantas líneas como
  la cantidad — un conteo que no coincide se rechaza antes de crear nada.

Las etiquetas de activo automáticas siguen aplicando: si tu instancia usa un
[esquema de etiquetas](/help/configuration-asset-tag-scheme), cada unidad se etiqueta automáticamente a
medida que se crea.

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

## Cuándo usar la importación en su lugar

Recibir stock es para unidades **nuevas** de un modelo que ya tienes. Para cargar un inventario
**existente** desde una planilla o una herramienta previa — muchos modelos distintos, con sus propios
números de serie y responsables — usa el [importador masivo](/help/assets-bulk-import) en su lugar.

## Qué sigue

- [Conceptos básicos de activos](/help/assets-asset-basics) — el formulario de un activo y todo lo que
  contiene.
- [Asignaciones e historial](/help/assets-assignments-history) — entrega un activo recibido a su
  responsable.
