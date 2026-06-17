---
title: Construir un flujo de trabajo
order: 2
category: access-automation
subcategory: building-a-workflow
---

# Construir un flujo de trabajo

Los flujos de trabajo se construyen desde la pestaña **Flujos de trabajo** de una aplicación. Un flujo
necesita dos cosas: una **conexión** que indica *cómo* llega lazyit al sistema externo, y una
**secuencia de pasos** que indica *qué* hacer cuando se activa el disparador.

## 1. Añade una conexión

Una conexión es la configuración reutilizable de transporte y credencial de un sistema externo. Abre
la pestaña Flujos de trabajo, elige **Añadir conexión** y selecciona un **tipo**:

- **API / HTTP** — llamar a cualquier API HTTP/JSON (por ejemplo, «crear un usuario en Jira»).
- **Webhook** — enviar un POST firmado a una URL de webhook (por ejemplo, a tu propia plataforma de
  automatización).
- **Tarea humana** — sin llamada externa; una persona hace el trabajo (se cubre en
  [Tareas manuales](/help/access-automation-manual-tasks)).

Para una conexión API defines una **URL base** y un **método de autenticación** (ninguna, token
Bearer, autenticación básica o una cabecera de API key). Para una conexión Webhook defines la **URL
del webhook**. El **tipo no se puede cambiar** después de crear la conexión — recréala si necesitas
otra.

### Las credenciales son de solo escritura

Si la conexión necesita una credencial, la añades en la conexión. El valor se introduce **una sola
vez, se guarda cifrado y no se vuelve a mostrar** — después solo puedes **Reemplazar** o **Eliminar**
la credencial. lazyit únicamente te indica si una credencial está *configurada*, nunca su valor. La
custodia de credenciales puede separarse de la construcción de flujos (consulta
[Permisos](/help/access-automation-permissions)).

## 2. Añade pasos

Elige **Nuevo flujo**, dale un nombre, escoge su **disparador** (Acceso concedido o Acceso revocado)
y su conexión, y luego añade **pasos** desde la paleta **Añadir paso**. Hoy se incluyen tres tipos de
paso:

- **API / HTTP** — una solicitud autenticada (GET/POST/PUT/PATCH/DELETE) a una ruta sobre la URL base
  de la conexión.
- **Webhook** — un POST firmado de tu payload mapeado a la URL del webhook de la conexión.
- **Tarea humana** — pausar la ejecución para que actúe una persona.

(Los tipos de paso SDK de proveedor y MCP aparecen en la paleta como **Próximamente** y aún no se
pueden añadir.)

Los pasos se ejecutan **de arriba abajo**. Reordénalos con los controles de subir/bajar. El
disparador no se puede cambiar tras crear el flujo — recrea el flujo para cambiarlo.

## 3. Mapea datos en la solicitud

Cada paso API o Webhook tiene un **Mapeo de datos**: una lista de campos externos y el valor que toma
cada uno. Un valor puede ser un literal fijo, un único **token** del contexto de la concesión, o
varios tokens y texto **compuestos** juntos. Los tokens se insertan desde un selector agrupado por
origen:

- **Evento disparador**, **Beneficiario** (correo, nombre, apellido, id), **Aplicación**,
  **Concesión** y las salidas de pasos anteriores.

Mapeas eligiendo un campo de contexto, componiéndolo, o — mediante **Avanzado** — editando
directamente el JSON del mapeo. Los tokens se escriben así: `{{ grantee.email }}`. El mapeo es **solo
de valores**: cableas el contexto en los campos, pero no puedes escribir código ni condiciones en un
mapeo. El editor te avisa si hay llaves sin cerrar, un token mal formado o un origen de token
desconocido para que lo corrijas antes de guardar.

También puedes poner un token **en la ruta de la solicitud** — por ejemplo un id de usuario en
`/users/…/deactivate` — y el editor muestra una vista previa de la ruta resultante.

## 4. Decide qué cuenta como éxito y qué pasa al fallar

El editor de cada paso tiene las pestañas **Reintentos** y **Flujo**:

- **Códigos de estado de éxito** — qué respuestas HTTP cuentan como éxito (por defecto, cualquier
  `2xx`).
- **Reintentar al fallar** — reintenta los fallos transitorios antes de rendirse: define el número de
  **Intentos**, la **Espera** (fija o exponencial) y un retardo. Marca un paso como **Idempotente**
  solo si es seguro reintentarlo sin aprovisionar dos veces.
- **Al tener éxito →** continuar al siguiente paso (por defecto), terminar la ejecución como
  completada o ir a un paso concreto.
- **Al fallar →** **Avisar y detener** (por defecto — marcar la ejecución como fallida y detenerse; la
  concesión nunca se toca), **Escalar a una persona** (pausar y abrir una tarea manual), **Ejecutar un
  paso de compensación** (deshacer un cambio a medias y detenerse) o **Continuar de todos modos**.

Estas aristas de éxito y de fallo son lo que te permite construir una secuencia con manejo de errores
en lugar de una línea recta ciega.

## 5. Actívalo

Un flujo solo se dispara cuando está **Activado**. Actívalo desde la lista de flujos (o en el
constructor) cuando estés listo. Antes de activarlo, valídalo con una **simulación** y con **Probar
conexión** — consulta [Pruebas y observabilidad](/help/access-automation-testing-observability).

## Política de desaprovisionamiento con varias concesiones

Para un flujo de Acceso revocado eliges una **Política de desaprovisionamiento**: desaprovisionar
**solo cuando se revoca la última concesión activa** (el valor por defecto seguro — nunca corta el
acceso de alguien que aún conserva otra concesión válida para esa aplicación), o **en cada concesión**
revocada.
