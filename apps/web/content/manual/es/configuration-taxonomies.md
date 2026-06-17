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

Cada pestaña es su propia lista de crear / editar. Añade una entrada nueva, renómbrala o elimina la que
ya no necesites.

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
