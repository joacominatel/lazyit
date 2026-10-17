---
title: Aplicaciones
order: 1
category: applications-access
subcategory: applications
---

# Aplicaciones

La sección **Acceso** es tu catálogo de aquello a lo que las personas obtienen acceso: productos
SaaS (GitHub, Jira, AWS), sistemas internos y servicios técnicos (una VPN, un grupo de AD). Cada
entrada es una **aplicación**, y lazyit registra quién puede acceder a cada una. Esta página cubre
cómo construir y organizar ese catálogo; otorgar acceso se explica en
[Concesiones de acceso](/help/applications-access-grants).

## Qué es una aplicación

Una aplicación es simplemente un destino con nombre al que alguien puede tener acceso. Solo el
**nombre** es obligatorio — todo lo demás es opcional y está para ayudar a tu equipo a
reconocerla y encontrarla:

- **Fabricante** — quién hace el software (Atlassian, Microsoft, AWS…). Sugiere los fabricantes ya
  en uso. No es a quién se lo compras — eso es un [proveedor](/help/purchases-recording-purchases).
- **Categoría** — un agrupamiento para explorar (ver más abajo).
- **URL** — dónde vive el sistema. Puede ser una dirección `https://…` normal o un host interno
  sin esquema como `vpn.corp.local`. Por seguridad solo se aceptan hosts sin esquema y enlaces
  `http(s)`; otros esquemas se rechazan.
- **Crítica** — una marca para destinos especialmente sensibles (ver
  [Criticidad y alertas](/help/applications-criticality-alerts)).
- **Descripción** y **Notas** — texto libre para dar contexto.
- **Licencia y asientos** — datos de licenciamiento opcionales (asientos comprados, costo por
  asiento, fecha de renovación). Ver [Licencia y asientos](#licencia-y-asientos) más abajo.

## Agregar y editar aplicaciones

Desde el listado de **Acceso**, elige **Nueva aplicación**, completa al menos un nombre y créala.
Abre cualquier aplicación para ver su página (más abajo) y elige **Editar** arriba. Dos atajos
agilizan la configuración repetitiva:

- **Clonar** crea una nueva aplicación precargada a partir de una existente — útil para sistemas
  similares. El clon es una aplicación *aparte*; le otorgas acceso de forma independiente.
- **Editar** actualiza cualquier campo en cualquier momento. Para quitar un valor, vacía el campo (o
  deja la categoría en ninguna) y guarda.

Crear y editar aplicaciones es trabajo de catálogo cotidiano, disponible para administradores y
miembros. **Eliminar** una aplicación es una acción solo de administrador.

## La página de la aplicación

Al abrir una aplicación ves todo sobre ella en una sola página, con la misma estructura que un
activo o una persona:

- **El encabezado** — el nombre, un distintivo **Crítica** cuando la aplicación está marcada como
  crítica, y el fabricante, la categoría y la URL. La acción principal está a la derecha: **Otorgar
  acceso** para administradores, o **Solicitar acceso** para el resto (se convierte en *Acceso
  solicitado* o *Tienes acceso* cuando eso ya aplica). **Editar** está al lado; **Clonar** y
  **Eliminar aplicación** están en el menú **⋯**.
- **Requiere atención** — una fila corta con lo que necesita seguimiento, lo más urgente primero:
  accesos vencidos que esperan ser revocados, más personas que asientos comprados, una renovación de
  licencia en los próximos 30 días o ya pasada, accesos que vencen en los próximos 30 días, personas
  desactivadas que todavía tienen acceso y solicitudes que esperan una decisión. Cuando nada requiere
  atención, la fila no aparece.
- **Datos clave** — **Personas con acceso** (personas distintas, con la cantidad de accesos
  activos), **Asientos** (usados / comprados, con una barra), **Renovación** y **Solicitudes
  pendientes**. Personas con acceso y Solicitudes pendientes abren su pestaña al hacer clic.
- **Pestañas** — **Accesos** (quién tiene acceso, ver [Concesiones de acceso](/help/applications-access-grants)),
  **Solicitudes** (las solicitudes de acceso de esta aplicación, ver
  [Solicitudes de acceso](/help/applications-access-requests)), **Automatización** (sus flujos,
  ejecuciones recientes y conexión, ver [Automatización de accesos](/help/access-automation-concepts)),
  **Actividad** (cada otorgamiento y revocación, lo más reciente primero) e **Información**
  (descripción, notas y datos de licencia). Una pestaña aparece solo si puedes ver lo que lista: de
  forma predeterminada los miembros ven Accesos y Solicitudes, y solo los administradores ven
  Automatización y Actividad. La pestaña abierta queda en la dirección, así que un enlace compartido
  abre en la misma pestaña.
- **La columna lateral** — los detalles (fabricante, categoría, URL, criticidad, cuándo se dio de
  alta y cuándo se actualizó) y los artículos de la base de conocimiento vinculados a la aplicación.
  En un teléfono, la columna lateral pasa debajo de las pestañas.

## Categorías

Las categorías organizan el catálogo para que siga siendo navegable a medida que crece. lazyit
incluye un conjunto inicial — **SaaS, Internal, Service, Third Party, Infrastructure, Other** —
pero las categorías son totalmente tuyas: renómbralas, agrega las tuyas o quita las que no uses.
La categoría es opcional; una aplicación sin categoría es perfectamente válida.

Eliminar una categoría nunca elimina las aplicaciones que contiene. Si todavía tiene aplicaciones,
lazyit te muestra cuáles y te pide **una sola decisión para todas**: dejarlas sin categoría, moverlas
a otra categoría o, si puedes crear categorías, escribir un nombre para crear una ahí mismo y moverlas
a ella. No se pierde nada, y restaurar la categoría después no las devuelve.

## Encontrar aplicaciones

El listado de Acceso permite buscar por **nombre o fabricante**, y filtrar por **categoría** y por
**criticidad** (solo críticas / no críticas / cualquiera). Cada fila muestra además el número de
**acceso activo** — cuántas personas tienen actualmente una concesión vigente sobre esa
aplicación — y, cuando registras el licenciamiento, una celda de **Licencia** (usados / comprados,
con una advertencia de sobreasignación y la próxima fecha de renovación), para que veas de un
vistazo qué sistemas están en uso.

**Exportar CSV** descarga todas las aplicaciones que coinciden con la búsqueda actual y los filtros de
categoría y criticidad — mira [Exportar datos](/help/notifications-activity-data-export).

## Licencia y asientos

lazyit puede registrar el licenciamiento detrás de una aplicación, para que veas de un vistazo
cuánto de lo que pagas está realmente en uso. En el formulario de la aplicación, completa
cualquiera de estos:

- **Asientos comprados** — cuántos asientos pagos incluye la licencia. Déjalo en blanco para no
  fijar un límite.
- **Costo por asiento** — el precio de un solo asiento, por período de facturación. Ingrésalo en
  unidades normales, con el formato de números de tu idioma (`12,99` en español, `12.99` en inglés —
  ver [escribir importes](/help/assets-asset-basics#escribir-importes)); lazyit guarda el importe con
  precisión.
- **Fecha de renovación** — cuándo se renueva la licencia por próxima vez.

Los **asientos en uso** se calculan solos: es la cantidad de *personas distintas* que tienen
acceso activo a la aplicación en este momento. Como una misma persona puede tener más de una
concesión sobre la misma app, lazyit cuenta *personas*, no concesiones — así el número refleja el
consumo real de la licencia.

El listado de Acceso y el dato clave **Asientos** de cada aplicación muestran **usados /
comprados**; la pestaña **Información** lista los tres campos de licencia. Cuando más personas tienen
acceso que los asientos comprados, lazyit marca la aplicación como **sobreasignada**, en el listado y
en la fila *Requiere atención* de la página — un aviso para comprar más asientos o revocar accesos que ya no hacen falta. La
advertencia es informativa: lazyit nunca bloquea una concesión por la cantidad de asientos.

Todos los campos de licencia son opcionales — déjalos en blanco para aplicaciones que no licencias
por asiento.

## Eliminar una aplicación

Eliminar es un **borrado lógico**: la aplicación se oculta del catálogo, pero su registro (y el
historial de acceso asociado) se conserva, de modo que las pistas de auditoría quedan intactas. Un
administrador puede **restaurar** una aplicación eliminada más tarde. Como las eliminaciones son
reversibles, lazyit nunca pierde el registro de quién tuvo acceso a qué.

> Quitar una aplicación del catálogo no revoca el acceso de nadie. El acceso se registra por
> separado y se conserva para auditoría — ver [Concesiones de acceso](/help/applications-access-grants).
