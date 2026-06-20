---
title: Importación masiva
category: assets
subcategory: bulk-import
order: 1
---

# Importación masiva

El **importador masivo** carga en lazyit un inventario de activos existente desde un único archivo CSV
o JSON. Está pensado para el primer día de una instancia nueva, cuando tu inventario todavía vive en
una hoja de cálculo o en una herramienta heredada. Se controla desde **Importador** en la barra
lateral.

El importador es **solo para administradores** — requiere el permiso `import:run`, que los
administradores tienen por defecto. Si no lo ves, pídele a un administrador que haga la importación.

> **Qué puedes importar hoy.** Solo activos. La importación de usuarios, consumibles e historial aún no
> está disponible a propósito, y se indica como *próximamente* en el asistente. La
> **asignación/propietario** de un activo también queda fuera de esta primera fase.

## El flujo de un vistazo

El importador es un asistente guiado. **No se escribe nada en tus datos hasta el paso final de
confirmación**, e incluso entonces cada fila se vuelve a comprobar antes de guardarse.

1. **Subir** — elige qué vas a importar (Activos) y selecciona tu archivo.
2. **Resumen** — confirma el número de registros, la codificación y las columnas detectadas.
3. **Mapeo** — ve columna por columna: envía cada una a un campo de lazyit, guárdala como campo
   personalizado, o ignórala.
4. **Vista previa** — una *simulación* que valida cada fila sin escribir nada.
5. **Conflictos** — resuelve las referencias que coincidieron (o no) con registros existentes.
6. **Confirmar** — la importación se ejecuta y obtienes un informe de resultados.

Puedes volver **Atrás** en cualquier paso antes de confirmar para cambiar tus respuestas.

## 1. Sube tu archivo

Exporta tu hoja de cálculo como **CSV (UTF-8)**, o proporciona un **arreglo JSON** de objetos. Cada
fila (u objeto) se convierte en un activo.

- Los archivos `.xlsx` **no** se aceptan — expórtalos a CSV primero.
- El archivo se analiza en segundo plano; suele tardar unos segundos.
- Las columnas de solo fecha y cualquier columna de marca temporal `created`/`updated`/`deleted` se
  rechazan — esta primera fase importa el *estado actual* de un activo, no su historial.

## 2. Confirma el resumen

Tras el análisis, el importador muestra el **número de registros**, la **codificación** detectada, el
**delimitador** y la lista de **columnas** que encontró. Úsalo para confirmar que el archivo se
analizó como esperabas antes de dedicar tiempo al mapeo. Si encontró cero filas, vuelve y revisa el
archivo.

## 3. Mapea tus columnas

El mapeo es **por columna**: el importador lista **todas las columnas de tu archivo**, cada una como su
propia tarjeta que muestra el nombre de la columna y algunos **valores de ejemplo** tomados de tu
archivo, para que sepas siempre qué estás viendo antes de decidir a dónde va.

> **Atención — esta pantalla muestra tus datos reales.** Los valores de ejemplo se toman directamente
> del archivo, así que pueden incluir datos de empleados como nombres y correos. No se escribe nada en
> ningún sitio hasta la confirmación final; los valores solo se te muestran a ti, el operador que
> ejecuta la importación.

Para cada columna, ábrela y elige un destino en el desplegable:

- **Un campo de lazyit**, agrupado por entidad:
  - **Activo** — **Nombre** (*obligatorio*), **Estado** (*obligatorio*), **Número de serie**,
    **Etiqueta de activo**, **Fecha de compra**, **Fin de garantía**, **Modelo** y **Ubicación**.
  - **Modelo** — **Fabricante** y **Categoría** para los modelos de activo que cree la importación
    (consulta *Marca y categoría del modelo* más abajo).
- **Crear un campo personalizado…** — para una columna sin hogar nativo (RAM, IMEI, pulgadas, costo,
  una URL externa…). Le das un nombre y su valor se guarda en los **detalles** del activo (`specs`).
  Un campo personalizado se guarda **solo en las filas que realmente tienen un valor** — las celdas
  vacías no añaden nada.
- **Ignorar** — descartar la columna. **Las columnas vacías e irrelevantes quedan en Ignorar por
  defecto**, así que una exportación ancha con decenas de columnas sin uso no es un muro de trabajo;
  solo tocas las que importan.

Algunos campos se comportan de forma especial:

- **Nombre** y **Estado** son **obligatorios**: debes mapear una columna a cada uno antes de continuar.
- Los valores de **Estado** se concilian **dentro de la tarjeta de esa columna** — cada valor de
  estado distinto de tu archivo se asocia a un estado de lazyit (por ejemplo `active → OPERATIONAL`,
  `retired → RETIRED`). Los sinónimos comunes se completan por ti; cambia cualquiera.
- **Número de serie** es opcional pero **importante**: es la única clave natural del activo. Si lo
  mapeas, una nueva subida no creará duplicados de esas filas. Sin él, una nueva subida **no se
  de-duplica**.
- **Etiqueta de activo** — una etiqueta de tu archivo se usa tal cual; una en blanco se asigna
  automáticamente más tarde si tu instancia tiene un esquema de etiquetas activado.
- **Modelo** y **Ubicación** son **referencias**, asociadas a registros existentes por nombre
  (consulta *Conflictos*).

El importador **pre-rellena una mejor suposición** para cada columna, pero nunca decide por ti —
confirmas cada columna, y nada se descarta en silencio.

### Marca y categoría del modelo

Cuando la importación crea un **Modelo** nuevo, necesita un **fabricante** y una **categoría**. Puedes
definirlos de dos maneras:

- **Por fila** — mapea una columna a **Fabricante** o **Categoría** en el desplegable, y cada modelo
  toma su valor de esa fila.
- **Para todos los modelos** — si tu archivo no tiene esa columna (o todos tus activos son de la misma
  marca), fija un único **Fabricante** y/o **Categoría** en el recuadro *Marca y categoría del modelo*;
  se aplica a todos los modelos que cree la importación. Una columna mapeada siempre gana sobre un
  valor fijado.

## 4. Vista previa (la simulación)

La simulación valida, normaliza y resuelve **todas** las filas — **sin escribir nada**. Obtienes:

- Un recuento de filas **válidas** e **inválidas**.
- Resultados por fila, con el error de validación exacto de cada fila inválida (para que corrijas el
  archivo).
- **Colisiones de etiqueta de activo** — cualquier etiqueta de tu archivo que ya pertenezca a un
  activo vigente se marca aquí, nunca se descarta en silencio.

Como la vista previa ejecuta las *mismas* comprobaciones que la confirmación, lo que ves es lo que
obtendrás.

## 5. Resuelve los conflictos

Cuando tu archivo referencia un **modelo** o una **ubicación** por nombre, el importador busca un
registro existente. Para cada valor distinto te muestra las coincidencias que encontró, el **alcance**
(cuántas filas usan ese valor, con algunos números de fila de ejemplo) y te pide elegir uno de cuatro
resultados:

- **Vincular a un registro existente** (*match*) — usar un registro vigente que ya existe.
- **Restaurar un registro archivado** (*restore*) — recuperar un registro archivado (eliminado de
  forma reversible) y vincularlo.
- **Crear un registro nuevo** (*create*) — crear uno nuevo. Solo se ofrece cuando no existe una
  coincidencia vigente. El registro nuevo se crea con valores por defecto razonables que puedes editar
  después.
- **Omitir — dejar sin vincular** (*skip*) — importar las filas sin ese vínculo.

**lazyit nunca adivina por ti.** Cuando más de un registro coincide con un valor, el conflicto se
marca como *ambiguo* y debes elegir el registro concreto — el importador no seleccionará uno por ti.
Resuelves cada valor distinto **una vez**, y esa elección se aplica a todas las filas que lo comparten.

## 6. Confirma y el resultado

Cuando el plan está listo, la importación se ejecuta en segundo plano. Es **por lotes** y
**reanudable**, y sigue una regla de **conservar lo parcial**:

- Las filas correctas se **conservan** — un problema en una fila nunca revierte las que ya tuvieron
  éxito.
- Si alguien tomó un valor entre la vista previa y la confirmación, esa fila se registra como un
  **fallo** (no se descarta en silencio), y el resto continúa.

El informe de resultados muestra cuántas filas se **crearon**, **fallaron** y se **omitieron**, además
del id de la **ejecución de importación** para tu auditoría. Si algunas filas fallaron, corrígelas en
tu archivo y ejecuta el importador de nuevo — las filas ya importadas se omiten en una nueva ejecución
(cuando hay un número de serie mapeado).

## Bueno saberlo

- **Es aditivo y auditado.** El importador solo crea y vincula; nunca elimina ni sobrescribe tus
  activos existentes. Cada activo creado recibe una entrada de historial atribuida a ti.
- **Las sesiones expiran.** Una sesión de importación en curso se conserva 24 horas y luego se
  descarta. El registro de auditoría de una importación *completada* es permanente.
- **Los permisos siguen aplicándose al confirmar.** Más allá de `import:run`, crear un modelo o una
  ubicación nuevos durante un conflicto requiere el permiso de escritura correspondiente; el importador
  lo comprueba antes de escribir nada.
