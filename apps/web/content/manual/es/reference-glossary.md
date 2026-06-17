---
title: Glosario
order: 1
category: reference
subcategory: glossary
---

# Glosario

Un glosario A–Z conciso de los términos que encontrarás en lazyit, escrito para las personas que lo
operan. Las definiciones son deliberadamente breves — cada una enlaza a la página donde el tema se
trata en detalle.

## Activo

Una cosa concreta que el equipo de IT posee y de la que es responsable, registrada de forma
individual — un portátil, un servidor, un switch, una licencia, etc. El activo es el ciudadano de
primera clase de lazyit: permanece mientras las personas entran y salen. A diferencia de un
**consumible**, que se cuenta a granel. Consulta [Conceptos de
activos](/help/assets-asset-basics).

## Administrador

El rol con control total de la instancia: gestionar usuarios, cambiar la configuración, eliminar
registros y ajustar lo que pueden hacer los demás roles. Un administrador siempre tiene todos los
permisos y no se puede reducir. Consulta [Roles](/help/users-permissions-roles).

## Asignación

El vínculo con fecha entre un **activo y la persona que lo tiene**, con una fecha de inicio y (cuando
el activo se devuelve) una fecha de fin. Como las asignaciones se conservan en el tiempo, el historial
de propiedad de un activo es automático. Un activo puede tener más de un propietario activo a la vez.
Consulta [Asignaciones e historial](/help/assets-assignments-history).

## Automatización de accesos

El conjunto opcional de pasos, configurado por aplicación, que lazyit puede ejecutar **en tu nombre**
cuando se concede o se revoca un acceso — por ejemplo, abrir un ticket en otro sistema o llamar a una
API externa. Una aplicación sin automatización funciona con normalidad: conceder acceso simplemente
registra una [concesión de acceso](/help/applications-access-access-grants). Consulta
[Automatización de accesos](/help/access-automation-concepts).

## Bóveda

Un contenedor con forma de carpeta dentro del Gestor de Secretos que guarda elementos secretos y
tiene su propia lista de miembros. Una bóveda es un límite de **conocimiento cero**: el servidor puede
ver su nombre y sus miembros, pero nunca puede descifrar lo que hay dentro. Consulta [Bóvedas y
miembros](/help/secret-manager-vaults-members).

## Categoría de activos

Una clasificación para los **modelos** de activos — Portátil, Sobremesa, Servidor, Switch, Firewall y
similares. Las categorías sirven para agrupar y filtrar. Consulta [Modelos y
categorías](/help/assets-models-categories).

## Clave de recuperación

Tu **llave de respaldo** del Gestor de Secretos: un código largo de un solo uso con formato de cinco
grupos. Úsala para restablecer tu contraseña del Gestor de Secretos si la olvidas. Se muestra
**exactamente una vez**, durante la configuración — guárdala en un lugar seguro y fuera de lazyit.
Consulta [Contraseñas y claves de recuperación](/help/secret-manager-passwords-recovery-keys).

## Concesión de acceso

El registro de que un **usuario tiene acceso a una aplicación**, con la fecha en que se concedió y
(cuando termina) la fecha en que se revocó. Las concesiones se conservan en el tiempo en vez de
sobrescribirse, así que siempre tienes una respuesta a "quién puede acceder a qué — y quién podía el
mes pasado". Consulta [Concesiones de acceso](/help/applications-access-access-grants).

## Consumible

Un artículo de suministro **contado por stock** — cables, adaptadores, tóner, tornillos — donde
importa *cuántos* tienes, no *cuál*. A diferencia de un **activo**, que se registra individualmente.
Consulta [Consumibles](/help/consumables-consumables-categories).

## Contraseña (Gestor de Secretos)

El secreto que usas para desbloquear el Gestor de Secretos cada día. Se configura dentro del Gestor de
Secretos y la captura solo tu navegador — el servidor nunca la recibe. Es **distinta** de la
contraseña con la que inicias sesión. Consulta [Contraseñas y claves de
recuperación](/help/secret-manager-passwords-recovery-keys).

## Cuenta de servicio

Una credencial no humana para la automatización — un script o una integración que actúa sobre lazyit
sin que una persona inicie sesión. Es un tipo de principal distinto de un usuario, con su propio token
y sus propios permisos concedidos directamente; nunca es administrador. Consulta [Cuentas de
servicio](/help/users-permissions-service-accounts).

## Carpeta

El árbol que organiza la Base de Conocimiento. Una carpeta contiene artículos y subcarpetas, y es
también el **límite de acceso**: quién puede leer o editar una carpeta controla quién llega a los
artículos que hay dentro. Cada artículo tiene exactamente una carpeta de origen. Consulta [Carpetas y
acceso](/help/knowledge-base-folders-access).

## Elemento secreto

Un único valor secreto guardado en una bóveda — una contraseña, una clave o un token. Su valor se
cifra antes de salir de tu navegador; el servidor solo guarda la forma cifrada. Consulta [Bóvedas y
miembros](/help/secret-manager-vaults-members).

## Esquema de etiquetas de activos

La regla de toda la instancia que define la forma de las etiquetas de activos (prefijo, ancho del
número) y el contador que las alimenta. Consulta [Esquema de etiquetas de
activos](/help/configuration-asset-tag-scheme).

## Etiqueta de activos

El identificador corto y legible que se imprime o se pega en un activo físico (por ejemplo,
`LAP-0042`). lazyit puede asignar etiquetas de forma automática siguiendo un esquema que configuras.
Consulta [Etiquetas de activos](/help/assets-asset-tags).

## Flujo de trabajo

La secuencia de pasos configurada que se ejecuta como parte de la automatización de accesos de una
aplicación — una cadena de llamadas automáticas y tareas humanas (manuales) conectadas con rutas de
éxito y de fallo. Hay como máximo un flujo de trabajo por aplicación, y es opcional. Consulta [Crear
un flujo de trabajo](/help/access-automation-building-a-workflow).

## Lector

El rol de solo lectura. Los lectores pueden mirar la mayoría de las áreas pero no pueden cambiar nada,
y algunas vistas sensibles (el directorio de usuarios y el registro de concesiones de acceso) quedan
ocultas para ellos por defecto. Consulta [Roles](/help/users-permissions-roles).

## Miembro

El rol de trabajo cotidiano. Los miembros pueden leer y crear o editar la mayoría de las cosas —
activos, aplicaciones, consumibles, la Base de Conocimiento — pero por defecto no pueden eliminar
registros ni realizar acciones reservadas al administrador. Consulta [Roles](/help/users-permissions-roles).

## Modelo de activos

El make/model genérico del que un activo es una instancia — por ejemplo, "Dell Latitude 7440" o
"Cisco Catalyst 9300". El modelo guarda los datos que comparten todas las unidades, para que los
activos individuales no los repitan. Consulta [Modelos y categorías](/help/assets-models-categories).

## Movimiento de stock

Una entrada en el libro de movimientos de un consumible que registra un cambio en la cantidad — stock
añadido (`IN`), retirado (`OUT`) o fijado en una cifra exacta (`ADJUSTMENT`). El libro es de solo
adición y es la fuente de verdad de la cifra de stock actual. Consulta [Movimientos de
stock](/help/consumables-stock-movements).

## Notificación

Un aviso operativo que aparece en la **campana** dentro de la app — por ejemplo, acceso a una
aplicación crítica, una elevación de administrador, stock bajo o una tarea de flujo de trabajo que te
espera. Consulta [Campana de notificaciones](/help/notifications-activity-notification-bell).

## Permiso

Una sola capacidad escrita como `área:acción` — por ejemplo, `asset:write` (crear o editar activos) o
`consumable:read` (ver consumibles). Un rol tiene un conjunto de permisos; lazyit los comprueba cada
vez que actúas. La lista completa de permisos es fija y se publica con el producto. Consulta
[Permisos](/help/users-permissions-permissions).

## Rol

Uno de los tres roles fijos — **Administrador**, **Miembro**, **Lector** — y cada usuario tiene
exactamente uno. Los roles no se pueden crear ni eliminar; lo que un administrador sí puede cambiar es
el conjunto de permisos detrás de Miembro y Lector. Consulta [Roles](/help/users-permissions-roles).

## Solicitud de acceso

Una petición pendiente, sujeta a aprobación, para acceder a una aplicación. Una solicitud se convierte
en una **concesión de acceso** una vez aprobada. Consulta [Solicitudes de
acceso](/help/applications-access-access-requests).

## Tarea manual

Un **paso humano** dentro de un flujo de trabajo de automatización de accesos. Cuando un flujo de
trabajo llega a una tarea manual, se pausa y espera a que una persona la complete desde la bandeja de
tareas; una vez hecha, el flujo continúa. Es una cola de aprovisionamiento, no un sistema de tickets
general. Consulta [Tareas manuales](/help/access-automation-manual-tasks).

## Ubicación

Dónde vive físicamente un activo — una oficina, un datacenter, un rack, un almacén o "remoto / con el
empleado". Las ubicaciones responden la mitad "¿dónde está?" de la pregunta del inventario. Consulta
[Ubicaciones](/help/assets-locations).

## Actividad

El historial de solo lectura de todo el parque sobre lo que pasó en la instancia — quién creó, cambió,
concedió o revocó algo, y cuándo. Es de solo adición: las entradas nunca se editan ni se eliminan.
Consulta [Actividad e informes](/help/notifications-activity-activity-reports).
