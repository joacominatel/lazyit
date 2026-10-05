---
title: Taxonomías
category: configuration
subcategory: taxonomies
order: 2
---

# Taxonomías

Las **taxonomías** son los vocabularios controlados que clasifican tus registros. En lugar de permitir
que cualquiera escriba una categoría en texto libre, lazyit mantiene una lista curada por tipo de
registro, de modo que lo mismo siempre se llame igual — lo que mantiene consistentes el filtrado, los
informes y la búsqueda. Se gestionan todas desde **Configuración → Taxonomías** (solo administradores).

## Qué puedes gestionar

La pantalla de Taxonomías es una sola página con una barra de pestañas. Cada pestaña gestiona un tipo:

- **Categorías de activo** — cómo se agrupan los activos (p. ej. portátiles, monitores, teléfonos).
- **Categorías de aplicación** — cómo se agrupan las aplicaciones.
- **Categorías de consumible** — cómo se agrupan los consumibles.
- **Categorías de artículo** — cómo se archivan los artículos de la base de conocimiento.
- **Modelos de activo** — los registros de marca/modelo que los activos referencian (p. ej. *Dell
  Latitude 5440*). Un modelo reúne los datos compartidos, así cada activo solo guarda lo que es propio
  de esa unidad.
- **Estados** — los nombres propios de tu equipo para los estados de activo predefinidos (consulta
  [Estados de activo personalizados](#estados-de-activo-personalizados) más abajo). Opcional.

Cada pestaña es su propia lista de crear / editar. Añade una entrada nueva, renómbrala o elimina la que
ya no necesites.

**Eliminar varias a la vez.** Marca las casillas de las filas que quieras quitar y usa **Eliminar** en
la barra de selección. lazyit las elimina una por una e informa el resultado: como una categoría que
**aún está en uso** (tiene artículos o subcarpetas) está protegida y no se puede quitar, un lote puede
terminar como un **éxito parcial**: las libres se eliminan y las que están en uso se **conservan y se
omiten**, con un resumen como *"Se eliminaron 3, 2 omitidas (aún en uso)"*. Las filas omitidas quedan
seleccionadas para que primero reasignes sus registros y vuelvas a intentarlo. (El borrado masivo
requiere el permiso de eliminación de categorías; las casillas solo aparecen si lo tienes.)

## Estados de activo personalizados

Cada activo tiene uno de seis **estados predefinidos**: Operativo, En mantenimiento, En depósito,
Retirado, Perdido y Desconocido (consulta [Estado](/help/assets-asset-basics#estado)). Son fijos, y son
los que leen el panel, los filtros, las importaciones, los informes y todas las demás reglas. Los
**estados personalizados** permiten que tu equipo use sus propias palabras encima de ellos: *En
reparación en el proveedor* y *En el banco de trabajo* pueden ser dos formas de *En mantenimiento*;
*Pool de préstamo* y *Esperando imagen* pueden ser dos formas de *En depósito*.

Son **opcionales**. Si nunca creas uno, nada cambia: los activos siguen usando los estados
predefinidos como siempre, e incluso cuando ya tengas algunos, cualquier activo puede quedarse con un
estado predefinido sin nombre propio.

**Cómo se corresponden.** Cada estado personalizado pertenece a **un único** estado predefinido. Darle
a un activo un estado personalizado también fija su estado predefinido en ese — así, un activo en
*Pool de préstamo* cuenta como *En depósito* en todos los lugares donde importa el estado predefinido
(el gráfico del panel, el filtro **En depósito**, los informes). La pestaña **Estados** muestra esta
correspondencia directamente: los seis estados predefinidos son encabezados de grupo fijos, y tus
estados personalizados aparecen bajo el que corresponde a cada uno.

**Crear y editar.** Usa **Nuevo estado personalizado**, o **Agregar** en el encabezado de un estado
predefinido para empezar dentro de él. Un estado personalizado tiene:

- **Nombre** — obligatorio, único entre los estados personalizados vigentes.
- **Estado predefinido** — aquel del que es una forma.
- **Color** — opcional. Elige uno de la paleta o escribe un valor `#RRGGBB`; colorea el punto junto al
  nombre. Si lo dejas vacío, el punto usa el color del estado predefinido.
- **Descripción** y **Orden** — opcionales. El orden ordena los estados personalizados dentro de su
  estado predefinido (los menores primero).

La columna **Activos** cuenta los activos que usan cada estado personalizado; haz clic en el número
para abrir la lista de Activos filtrada por él.

**El estado predefinido queda bloqueado mientras está en uso.** No puedes pasar un estado
personalizado a otro estado predefinido mientras algún activo lo use — esos activos cambiarían de
estado sin avisar. El campo aparece deshabilitado e indica cuántos activos lo usan. Mueve primero esos
activos a otro estado, o crea un estado personalizado nuevo.

**Archivar uno que está en uso pregunta a dónde van sus activos.** Cuando archivas un estado
personalizado que todavía usan algunos activos, lazyit te pide elegir un destino — otro estado
personalizado o un estado predefinido — y te dice cuántos activos se moverán. El movimiento y el
archivado ocurren juntos, y cada activo movido recibe una entrada en su historial. Un estado
personalizado que ningún activo usa se archiva con una confirmación simple.

Los **estados archivados** aparecen con **Mostrar archivados** (administradores), donde puedes
**Restaurar** uno. Un estado personalizado restaurado vuelve sin activos — se movieron al archivarlo.

Gestionar estados personalizados usa los mismos permisos que las categorías: verlos requiere el
permiso de ver categorías, crearlos y editarlos el de editar categorías, y archivarlos o restaurarlos
el de eliminar categorías.

## Cómo se relacionan las taxonomías con los registros

Una categoría o un modelo es una **referencia** a la que apuntan los registros — no es el registro en
sí. Un activo *pertenece a* una categoría de activo y *es un* modelo; no posee una copia privada de
ninguno. Por eso importa mantener la lista curada: renombra una categoría una vez y todos los registros
que la referencian lo reflejan.

Como los registros dependen de estas entradas, lazyit las protege: siguen las mismas reglas de
**borrado lógico y auditoría** que el resto del dominio, así que eliminar una entrada de taxonomía no
rompe en silencio los registros que la referencian. Si una entrada está en uso, primero corrige o
reasigna los registros.

## Dónde gestionar la configuración relacionada

- **Ubicaciones** son un registro hermano, accesible desde la página de inicio de Configuración y no
  desde una pestaña de Taxonomías — describen *dónde* están los activos, no *de qué tipo* son.
- **Categorías frente a modelos de activo** — las categorías son cubos amplios para agrupar y filtrar;
  los modelos son definiciones concretas de marca/modelo. Usa las categorías para segmentar tu parque,
  y los modelos para no volver a escribir los mismos datos de hardware en cada unidad.

Para ver cómo los modelos y las categorías impulsan la experiencia de activos, consulta la sección
Activos de este manual.

## Con el asistente de IA

Si el [asistente de IA](/help/ai-assistant-overview) está activado, también puedes pedirle que cree,
renombre o edite categorías de activos, aplicaciones y consumibles, que archive una, que edite, archive o
restaure modelos de activo y ubicaciones, y que cree, edite, archive o restaure estados de activo
personalizados. Cada cambio se propone como una tarjeta que apruebas, y una
tarjeta de archivado indica qué sigue usando la entrada antes de que decidas. Consulta
[Aprobar cambios](/help/ai-assistant-approvals#categorías-modelos-y-ubicaciones).
