---
title: Permisos
order: 5
category: access-automation
subcategory: permissions
---

# Permisos de automatización de accesos

La automatización de accesos tiene su propio conjunto de permisos para que puedas separar **quién
construye los flujos**, **quién los ejecuta**, **quién completa las tareas manuales** y **quién
custodia las credenciales**. Hay cinco:

| Permiso | Qué permite |
| --- | --- |
| **`workflow:read`** | Ver flujos, conexiones, el historial de ejecuciones y la bandeja de tareas manuales. |
| **`workflow:manage`** | Configurar el motor — crear, editar, eliminar y activar/desactivar flujos y conexiones. |
| **`workflow:run`** | Reintentar o repetir manualmente una ejecución. |
| **`workflow:task`** | Completar una tarea manual (además debes ser un destinatario permitido). |
| **`workflow:secrets`** | Añadir, reemplazar o eliminar las credenciales que usa una conexión. |

## Valor seguro por defecto: solo administrador

En una instalación nueva **los cinco los tiene solo el administrador**. Los miembros y observadores no
reciben ninguno por defecto — la automatización, como el historial de actividad y el Gestor de
secretos, empieza restringida a los administradores. Un administrador puede delegar cualquiera de
ellos en Miembro u Observador desde la configuración de permisos por rol (consulta
[Permisos](/help/permissions) para ver cómo funciona el ajuste de roles).

## Separación de funciones

La división es deliberada, para que distintas personas puedan asumir distintas responsabilidades:

- **`workflow:manage` frente a `workflow:secrets`.** Construir un flujo y custodiar sus credenciales
  son permisos **separados**. Puedes dejar que alguien diseñe y edite flujos sin darle nunca la
  capacidad de introducir o rotar los tokens de API que esos flujos usan — y al revés. Las credenciales
  son de solo escritura sin importar quién tenga este permiso: el valor se introduce una vez y no se
  vuelve a mostrar.
- **`workflow:task` no basta por sí solo.** Completar una tarea manual requiere el permiso **y** que
  seas un destinatario permitido de esa tarea. Tener `workflow:task` no te permite actuar sobre tareas
  destinadas a otra persona.

## Ajustar los valores por defecto

Conceder cualquiera de estos a Miembro u Observador es una delegación significativa, así que lazyit lo
marca con claridad y te pide confirmación — no te lo impide. El administrador siempre tiene todos los
permisos y no se puede editar.
