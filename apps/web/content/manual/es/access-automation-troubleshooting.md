---
title: Resolución de problemas
order: 6
category: access-automation
subcategory: troubleshooting
---

# Resolución de problemas de la automatización de accesos

Cuando la automatización no hace lo que esperas, la cronología de la ejecución casi siempre te dice
por qué. Empieza ahí: abre la pestaña **Flujos de trabajo** de la aplicación, busca la ejecución (o
fíjate en la etiqueta de la concesión — **Requiere atención** significa que una ejecución falló) y lee
su [cronología](/help/access-automation-testing-observability).

> Pase lo que pase con un flujo, **la concesión de acceso está a salvo.** Una ejecución fallida nunca
> revierte ni bloquea la concesión — solo significa que el sistema externo todavía no se actualizó.

## Una concesión no disparó ninguna automatización

Si conceder o revocar el acceso no produjo ninguna ejecución, comprueba, por orden:

- **¿Hay un flujo activado?** Una aplicación sin ningún flujo activado registra la concesión y no hace
  nada más — ese es el comportamiento opcional normal. Activa el flujo desde la lista de flujos.
- **¿Coincide el disparador?** Un flujo configurado como *Acceso concedido* no se dispara en una
  revocación (ni al revés). Confirma el disparador del flujo.
- **¿El flujo tiene pasos?** Un flujo sin pasos definidos no tiene nada que ejecutar, así que no se
  crea ninguna ejecución.
- **¿Es la aplicación correcta?** Los flujos son por aplicación; la concesión debe ser de la
  aplicación dueña del flujo.

## Un paso falló con un 4xx (400 / 401 / 403 / 404)

Un **4xx** es un error *permanente* y **nunca se reintenta** — reintentarlo no ayudaría. Suele
significar que la solicitud en sí está mal:

- **401 / 403** — la credencial falta, es incorrecta o no tiene permiso en el sistema externo. Añade o
  **Reemplaza** la credencial en la conexión y luego usa **Probar conexión**.
- **400 / 422** — el payload está mal formado o le falta un campo obligatorio. Revisa el **Mapeo de
  datos** del paso; lanza una **simulación** para previsualizar la solicitud exacta.
- **404** — la ruta es incorrecta, o referencia un id que no existe (frecuente en pasos de revocación
  que apuntan a una cuenta que nunca se creó). Revisa la **Ruta** del paso.

Corrige el flujo y luego usa **Repetir con la última versión** para un intento nuevo sobre tu versión
corregida. (Un **Reintentar** normal repite la versión antigua y no toma tus cambios.)

## Un paso falló con un 5xx, un tiempo de espera agotado o un error de red

Estos son **transitorios** — el sistema externo estuvo brevemente no disponible. Si el paso tiene
activado **Reintentar al fallar**, lazyit lo reintenta automáticamente con espera. Si agotó sus
intentos, corrige o espera al sistema externo y luego usa **Reintentar** en la ejecución fallida para
reanudar la misma ejecución desde el paso que falló.

## Una ejecución se quedó en «Esperando (manual)»

La ejecución se pausó para una persona — un paso de **Tarea humana** o un **Fallo escalado**. Seguirá
pausada hasta que alguien actúe. Abre la **bandeja de tareas manuales** (Configuración →
Integraciones), completa la tarea (**Enviar**, **Omitir paso** o **Fallar ejecución**) y la ejecución
se reanuda. Si no puedes actuar sobre ella, confirma que tienes **`workflow:task`** y que eres un
destinatario permitido — consulta [Tareas manuales](/help/access-automation-manual-tasks) y
[Permisos](/help/access-automation-permissions).

## «Repetir con la última versión» fue rechazado

Si repetir se rechaza porque la ejecución ya aprovisionó un paso no reversible, una ejecución nueva
crearía esa cosa por segunda vez. No lo fuerces — **vuelve a otorgar el acceso** en su lugar, lo que
inicia una ejecución nueva y limpia desde el principio.

## Una credencial no funciona y no puedes ver su valor

Eso es por diseño: las credenciales son de **solo escritura** — se introducen una vez, se guardan
cifradas y no se vuelven a mostrar. No puedes ver un valor guardado para comprobarlo; si sospechas que
es incorrecto, **Reemplázalo** por un valor que sepas correcto y usa **Probar conexión**.

## Nada parece ejecutarse, y ni siquiera arrancan los reintentos

La automatización corre en un trabajador en segundo plano. Si las ejecuciones se quedan **En cola** y
no avanzan, puede que el servicio de cola en segundo plano (Valkey) esté caído — consulta los
[servicios](/help/deployment-operations-services) y la
[resolución de problemas](/help/deployment-operations-troubleshooting) de tu despliegue. Las
concesiones en sí no se ven afectadas; las ejecuciones en cola se reanudan cuando el trabajador está
sano.
