---
title: Proxy inverso y TLS
order: 5
category: deployment-operations
subcategory: reverse-proxy-tls
---

# Proxy inverso y TLS

Toda petición a una instancia de lazyit llega a través de **Caddy**, el proxy inverso. Termina el HTTPS,
enruta el tráfico a la web y a la API, y es el **único** servicio que publica puertos al servidor. Todo
lo demás permanece en la red interna.

## Qué hace Caddy

- **Termina el TLS** y obtiene los certificados automáticamente (ver más abajo).
- **Enruta por ruta sobre un único origen.** El navegador llama a un solo origen; Caddy envía las
  peticiones de página a la web y las peticiones bajo `/api/` a la API (quitando el prefijo `/api`).
  Como todo es del mismo origen, una misma imagen web funciona en cualquier dominio.
- **Sirve el proveedor de identidad** en el subdominio `auth.` de tu dominio, con su propio certificado.
- **Añade cabeceras de seguridad básicas** a cada respuesta y oculta el identificador del servidor.

La configuración de Caddy vive en `infra/caddy/Caddyfile`. En la mayoría de los despliegues no lo editas:
defines valores en el archivo de entorno y, para un dominio público, descomentas dos líneas.

## TLS: certificados automáticos

Caddy aprovisiona certificados con **cero configuración**, en uno de dos modos:

- **Autoridad de certificación interna** — usada para `localhost` y despliegues privados. El certificado
  es TLS real pero los navegadores no confían en él por defecto, así que verás un aviso hasta que
  confíes en el certificado raíz de Caddy. Este es el modo para pruebas tipo producción local y para
  redes privadas o aisladas.
- **Let's Encrypt** — usado para un dominio real y accesible públicamente. Los certificados son de
  confianza pública (sin aviso) y se renuevan automáticamente. Requiere que tu dominio resuelva al
  servidor y que los puertos **80 y 443** sean accesibles.

## Salir en vivo con un dominio real

Para un despliegue público con HTTPS de confianza, define esto en `infra/env/.env.prod`:

- Tu **dirección del sitio** con tu nombre de dominio completo.
- Tu **dominio** (usado para construir el subdominio `auth.` del inicio de sesión).
- La URL de origen público (`https://tudominio.com`, sin barra final).
- Un **correo de contacto ACME** para Let's Encrypt — **y** descomenta la línea `email` en el Caddyfile.
- Los **puertos** publicados con los estándar `80` y `443` (los predeterminados son puertos altos para
  pruebas locales).

Para un dominio público real, activa además **HSTS** descomentando la línea `import hsts` en el bloque
del sitio del Caddyfile. HSTS indica a los navegadores que fuercen HTTPS durante un año.

> Activa HSTS solo en un dominio real y de confianza pública. **Nunca** lo actives en una instalación
> `localhost` o con CA interna: dejaría tu navegador fijado en HTTPS-solo para `localhost` en todos los
> proyectos.

## Confiar en el certificado local

En un despliegue tipo producción local, acepta el aviso del navegador o confía una vez en el certificado
raíz de Caddy. Puedes exportarlo del contenedor en marcha:

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
  cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-local-root.crt
```

Luego añade `caddy-local-root.crt` al almacén de confianza de tu sistema operativo o navegador. En un
dominio real con Let's Encrypt no hay aviso ni nada que confiar manualmente.

## Una nota sobre la documentación de la API

La página interactiva de documentación de la API **no** se sirve a propósito en el origen público. Una
petición a `/api/docs` en una instancia en vivo devuelve **404**: es un endurecimiento intencionado, no
una instalación rota. La documentación sigue siendo accesible en la red interna y en desarrollo local.

## Confianza y cabeceras reenviadas

Caddy actúa como el único salto delante de la API y reenvía la IP del cliente verificada. La API está
configurada para confiar exactamente en ese único salto, de modo que las funciones basadas en la IP de
la petición (limitación de tasa, la auditoría del primer arranque) ven al cliente real y no una cabecera
falsificada. Esto viene preconfigurado; no necesitas cambiarlo para un despliegue estándar en un único
servidor.

## Relacionado

- [Autoalojamiento](/help/deployment-operations-self-hosting)
- [Servicios](/help/deployment-operations-services)
- [Proveedor de identidad](/help/deployment-operations-identity-provider)
- [Resolución de problemas](/help/deployment-operations-troubleshooting)
