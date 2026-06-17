---
title: Zona horaria y formatos
category: configuration
subcategory: time-zone-formats
order: 4
---

# Zona horaria y formatos

lazyit muestra las fechas y horas en **una única zona horaria para toda la instancia**, y las da
formato según el idioma activo de la interfaz. Ambos vienen con valores sensatos por defecto; la zona
horaria es la que probablemente quieras configurar.

## Definir la zona horaria de visualización

Como lazyit es de una sola organización y autoalojado, toda la instancia muestra las horas en una
**única zona** — no hay zona horaria por usuario. Se define con la variable de entorno
`NEXT_PUBLIC_DEFAULT_TIME_ZONE` en el servicio web:

```
NEXT_PUBLIC_DEFAULT_TIME_ZONE=America/Argentina/Buenos_Aires
```

- Acepta cualquier nombre de zona **IANA** (por ejemplo `UTC`, `Europe/Madrid`,
  `America/Argentina/Buenos_Aires`).
- Si no la defines, lazyit usa **`UTC`** por defecto.
- El ajuste surte efecto al arrancar el servicio web, así que cámbialo en la configuración de tu
  despliegue y reinicia (o vuelve a desplegar) el servicio web.

> Configúrala con la zona real de tu equipo. Con el valor por defecto `UTC`, cada marca de tiempo se
> muestra en UTC — lo cual es correcto pero está desfasado según tu huso local, de modo que un evento
> de las 9:00 puede leerse como 12:00. Configurar la zona una vez hace que toda fecha y hora de la
> aplicación — paneles, informes, historial de actividad, la campana de notificaciones, el historial
> de activos — se lea en hora local.

Es solo un ajuste de visualización para toda la instancia. Cambia cómo se **muestran** los momentos; no
cambia los datos subyacentes, que siempre se almacenan como un instante absoluto en el tiempo.

## Cómo se da formato a fechas y horas

El **formato** (la forma en que se escribe una fecha) sigue el **idioma de la interfaz**, no la zona
horaria. El mismo momento se representa según las convenciones del idioma elegido:

- En tablas y listas se usa una fecha compacta — por ejemplo *25 may 2026* en español, *May 25, 2026*
  en inglés.
- Una fecha absoluta con hora acompaña las filas relevantes para auditoría — por ejemplo *25 may 2026,
  15:04* — de modo que una fila que registra cuándo ocurrió algo siempre lleva el momento exacto.

Donde importa la inmediatez se usa una expresión relativa (como "hace 2 horas"), con la fecha y hora
absolutas disponibles al pasar el cursor o para la tecnología de asistencia, así el momento preciso
nunca se pierde. Para cambiar el idioma del formato, cambia el idioma de la interfaz; consulta
[Idiomas](/help/getting-started-languages).
