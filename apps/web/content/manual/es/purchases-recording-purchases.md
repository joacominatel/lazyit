---
title: Compras y proveedores
category: purchases
subcategory: recording-purchases
order: 1
---

# Compras y proveedores

**Compras** guarda el lado de IT de lo que compra tu equipo: a qué proveedor se le compró, el número de
orden de finanzas, las facturas, las líneas y los precios, y cuántas de las unidades llegaron. Responde
preguntas como "¿qué activos están en la factura X?" o "¿llegó por fin la cuarta notebook de esa orden?".

lazyit **registra** compras; no gestiona el proceso de compra. Tu sistema de finanzas sigue siendo el
sistema de registro — aquí no hay aprobaciones, presupuestos, pagos ni cotizaciones.

## Es opcional

Nada en lazyit exige una compra. Un activo nunca la necesita, y los campos de compra del activo (fecha,
costo, moneda, garantía) siguen funcionando igual que antes, uses Compras o no. Si tu equipo nunca
registra una compra, el área simplemente queda vacía.

La encuentras en la barra lateral en **Inventario → Compras**, con dos pestañas: **Compras** y
**Proveedores**.

## Quién puede verla

Compras tiene sus propios permisos, separados de los de inventario:

| Capacidad | Administrador | Miembro | Lector |
| --- | :---: | :---: | :---: |
| **Ver compras y proveedores** | Sí | Sí | No |
| **Registrar y editar compras** (compras, líneas y proveedores) | Sí | Sí | No |
| **Eliminar compras y proveedores** (archivar y restaurar) | Sí | No | No |

**El Lector no tiene acceso por defecto**, porque las compras llevan precios y proveedores. Un
administrador puede concederlo desde la pantalla de permisos de roles (ver [Permisos](/help/permissions))
— pero los permisos son de un **rol**, no de una persona: concederlo al Lector se lo concede a **todos**
los lectores. Un lector sin ese permiso sigue viendo los campos de costo propios del activo, como antes.

## Registrar una compra

Elige **Nueva compra**. El formulario está pensado para ser rápido: solo hace falta lo que identifica la
compra — **un proveedor, una referencia o una línea**. Todo lo demás es opcional y se puede completar
después.

- **Proveedor** — escribe el nombre. Mientras escribes se sugieren los proveedores que ya usaste, y si
  lo que escribiste es solo otra forma de escribir uno existente (`COMPUMUNDO SA` por `Compumundo`), una
  pista te ofrece el existente. Un nombre que nadie usó todavía crea el proveedor al guardar — el campo
  te lo indica. Si varios proveedores tienen exactamente ese nombre, eliges cuál.
- **Referencia** — el número de orden de compra de finanzas. Es como se llama la compra en todas
  partes. Sin ella, la compra se lee como *Proveedor · fecha*, o *Compra · fecha* cuando tampoco tiene
  proveedor. Las referencias no se controlan como únicas.
- **Fecha de pedido** y **Estado** — *Pedida* (por defecto) o *Borrador*.
- **Moneda** — ver más abajo.
- **Más detalles** — entrega prevista, dónde se entrega, empresa, números de factura (un solo campo,
  con tantos como necesites), fecha de factura y notas.

### Líneas

Cada línea es algo que compraste. Una línea solo necesita una **descripción** — como figura en el
presupuesto o la factura. Su **cantidad** es 1 por defecto y el **precio unitario** es opcional (en
blanco significa desconocido; `0` significa sin cargo). El precio unitario suele ir sin IVA.

Hay dos tipos de línea:

- **Activo** — hardware que vas a registrar como activos. Puedes anotar la **marca** y el **modelo como
  figura** en el documento, asignarla a un **modelo de activo** si ya lo tienes (no es obligatorio — se
  puede asignar después) y registrar la **garantía** en meses.
- **Otro** — flete, un servicio, una bonificación. Cuenta en el total pero nunca espera una entrega.

El teclado hace casi todo: **Enter** en una línea agrega la siguiente, y **Ctrl+Enter** (**⌘+Enter** en
Mac) guarda la compra. El total acumulado se muestra debajo de las líneas.

Una vez guardada, las líneas se editan, agregan y quitan en la página de la compra. Una línea solo se
puede quitar mientras no se haya recibido ningún activo en ella.

## La moneda es una etiqueta

La **moneda** de una compra es una etiqueta de texto libre — `ARS`, `USD`, `u$s`, `pesos`, lo que
escriba tu equipo. lazyit no le da ningún significado: nunca convierte, nunca busca cotizaciones y nunca
cambia cómo se muestra un número. Dice en qué están los importes, nada más. El campo empieza con la
etiqueta que usaste por última vez y sugiere las que ya están en uso.

Por eso los totales se **agrupan por etiqueta y nunca se suman entre etiquetas**: una lista o un total
muestra un importe por moneda. Las etiquetas se comparan sin importar mayúsculas ni espacios, así que
`usd` y `USD` son el mismo grupo — pero `USD` y `u$s` son dos. Una compra sin etiqueta muestra sus
importes como **Sin moneda**, nunca como una moneda por defecto.

Los importes se escriben y se muestran con el formato de números de tu idioma — ver
[Escribir importes](/help/assets-asset-basics#escribir-importes).

## Estado y entrega

El estado lo fijas tú: **Borrador**, **Pedida** o **Cancelada**. Lo que llegó se calcula a partir de los
activos vinculados a cada línea, así que una compra pedida también se lee sola como **Recibida
parcialmente** o **Recibida**, y cada línea muestra **"3 de 4 recibidas"**, con las unidades pendientes o
canceladas.

- Una línea puede terminar con **más** unidades de las pedidas. Está permitido — se muestra como
  **Recibida de más**, como un aviso para revisar, nunca como un error.
- **Cancelar compra** (en el menú *Estado*) solo se ofrece mientras no se haya recibido nada. Una compra
  cancelada se puede volver a marcar como pedida.

La lista de **Compras** se abre en las compras que todavía **esperan unidades**; cambia el filtro para
verlas todas, o filtra por estado o proveedor, y busca por referencia, número de factura, proveedor o
ítem.

## El registro de actividad

Cada compra lleva un registro de **actividad** de solo agregado: quién la registró, quién cambió el
estado, quién agregó, editó o quitó una línea — con un cambio de precio o cantidad mostrado como
*antes → después*. No se puede editar ni borrar.

## Proveedores

La pestaña **Proveedores** es el directorio de a quién le compras y le pagas. Un proveedor **no** es el
fabricante del hardware (eso está en el modelo de activo) **ni** el fabricante del software (eso está en
la aplicación).

Un proveedor solo necesita un **nombre**. También puede tener un **ID fiscal**, un **sitio web**, un
**contacto comercial** y un **contacto de soporte / RMA** separado — útil cuando surge un reclamo de
garantía — y notas. Su página lista las compras que se le hicieron.

Los nombres y los ID fiscales no son únicos, así que lazyit nunca rechaza un duplicado; en cambio,
sugiere. Escribir un ID fiscal que otro proveedor ya tiene te dice de quién es.

## Archivar

Los administradores pueden **archivar** una compra o un proveedor. Archivar los oculta de las listas sin
borrarlos, cada activo conserva su vínculo, y se pueden restaurar desde la vista de archivados.
