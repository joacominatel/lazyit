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

- **Proveedor** — quién está detrás (Atlassian, Microsoft, AWS…).
- **Categoría** — un agrupamiento para explorar (ver más abajo).
- **URL** — dónde vive el sistema. Puede ser una dirección `https://…` normal o un host interno
  sin esquema como `vpn.corp.local`. Por seguridad solo se aceptan hosts sin esquema y enlaces
  `http(s)`; otros esquemas se rechazan.
- **Crítica** — una marca para destinos especialmente sensibles (ver
  [Criticidad y alertas](/help/applications-access-criticality-alerts)).
- **Descripción** y **Notas** — texto libre para dar contexto.

## Agregar y editar aplicaciones

Desde el listado de **Acceso**, elige **Nueva aplicación**, completa al menos un nombre y créala.
Abre cualquier aplicación para ver sus **Detalles** y editarla. Dos atajos agilizan la
configuración repetitiva:

- **Clonar** crea una nueva aplicación precargada a partir de una existente — útil para sistemas
  similares. El clon es una aplicación *aparte*; le otorgas acceso de forma independiente.
- **Editar** actualiza cualquier campo en cualquier momento.

Crear y editar aplicaciones es trabajo de catálogo cotidiano, disponible para administradores y
miembros. **Eliminar** una aplicación es una acción solo de administrador.

## Categorías

Las categorías organizan el catálogo para que siga siendo navegable a medida que crece. lazyit
incluye un conjunto inicial — **SaaS, Internal, Service, Third Party, Infrastructure, Other** —
pero las categorías son totalmente tuyas: renómbralas, agrega las tuyas o quita las que no uses.
La categoría es opcional; una aplicación sin categoría es perfectamente válida.

Eliminar una categoría nunca elimina las aplicaciones que contiene — simplemente las **desvincula**
y quedan sin categoría. No se pierde nada.

## Encontrar aplicaciones

El listado de Acceso permite buscar por **nombre o proveedor**, y filtrar por **categoría** y por
**criticidad** (solo críticas / no críticas / cualquiera). Cada fila muestra además el número de
**acceso activo** — cuántas personas tienen actualmente una concesión vigente sobre esa
aplicación — para que veas de un vistazo qué sistemas están en uso.

## Eliminar una aplicación

Eliminar es un **borrado lógico**: la aplicación se oculta del catálogo, pero su registro (y el
historial de acceso asociado) se conserva, de modo que las pistas de auditoría quedan intactas. Un
administrador puede **restaurar** una aplicación eliminada más tarde. Como las eliminaciones son
reversibles, lazyit nunca pierde el registro de quién tuvo acceso a qué.

> Quitar una aplicación del catálogo no revoca el acceso de nadie. El acceso se registra por
> separado y se conserva para auditoría — ver [Concesiones de acceso](/help/applications-access-grants).
