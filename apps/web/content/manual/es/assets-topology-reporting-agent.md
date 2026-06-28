---
title: Agente de reporte
category: assets
subcategory: topology
order: 3
---

# Agente de reporte

El **agente de reporte** completa tu inventario por vos. Es un programa pequeño que instalás en un
servidor Linux con un solo comando; a partir de ahí el servidor reporta *qué es* — su hardware y el
software instalado — a lazyit y mantiene esa imagen actualizada, así no tenés que cargarla ni
mantenerla a mano.

Es deliberadamente acotado. El agente reporta **solo inventario**: qué es un host y qué ejecuta,
nunca métricas, alertas ni datos de series temporales. lazyit es un CMDB, no una herramienta de
monitoreo. El agente descubre **solo el host donde se ejecuta** — no hay escaneo de red. Para cubrir
más servidores, lo instalás en más servidores.

> El agente solo **agrega propuestas**. Un host recién descubierto llega a la bandeja de **Revisión
> pendiente** como propuesta — nunca modifica tu inventario activo hasta que una persona lo confirma.

## Creá tu primer agente

En la vista **Servidores** (la vista Tabla de **Activos › Topología**), cuando todavía no tenés
agentes, aparece arriba una tarjeta **Creá tu primer agente**. Una vez que tenés agentes, se reduce a
un botón discreto **Agregar agente**. (Necesitás el permiso de gestión de configuración para usarlo,
porque crea un token.)

El botón abre un asistente guiado y breve, de tres pasos:

1. **Nombre y generación.** Poné un nombre que reconozcas más adelante (por ejemplo el nombre del
   servidor, como `web-prod-01`) y hacé clic en **Generar credenciales**. lazyit crea una cuenta de
   servicio limitada **únicamente** al permiso `infra:report`.
2. **Instalación.** lazyit te muestra un **comando de instalación** listo para pegar con el token ya
   incluido:

   ```sh
   curl -fsSL https://tu-instancia/install.sh | sudo sh -s -- --url https://tu-instancia --token <token>
   ```

   La dirección es **tu propia instancia de lazyit** — el agente solo se comunica con el servidor que
   vos ejecutás. Ejecutalo en un servidor **Linux** **como root**. El token se muestra **una sola
   vez**, así que copialo (o descargalo) antes de continuar. Si preferís revisar cada paso, expandí
   **Instalar manualmente (paso a paso)** para la misma instalación hecha a mano (descargar el binario,
   instalarlo, escribir el archivo de configuración y enviar un reporte de prueba).
3. **Espera.** El asistente entonces espera a que el servidor reporte. Apenas el agente reporta —
   normalmente en un par de minutos — muestra un mensaje de éxito y un botón **Confirmar** en línea.
   Podés confirmar ahí mismo, o cerrar el asistente y confirmarlo más tarde desde la bandeja de
   Revisión pendiente.

### Instalar manualmente (paso a paso)

La sección plegada **Instalar manualmente** del asistente da la misma instalación comando por comando,
para un administrador cauteloso que prefiere descargar e inspeccionar el binario primero. Cada paso
tiene su propio botón de copiar:

1. **Descargá el binario** (usá `arch=arm64` en máquinas ARM):

   ```sh
   curl -fsSL -H "Authorization: Bearer <token>" "https://tu-instancia/api/agent/download?arch=x64" -o lazyit-agent
   ```
2. **Hacelo ejecutable y movelo a su lugar:**

   ```sh
   chmod +x lazyit-agent && sudo mv lazyit-agent /usr/local/bin/
   ```
3. **Creá el archivo de configuración** (contiene el token, así que `chmod 600`) con `LAZYIT_URL` y
   `LAZYIT_TOKEN` en `/etc/lazyit-agent/config`.
4. **Enviá un primer reporte** para verificar que funciona:

   ```sh
   sudo lazyit-agent report --once
   ```

## Revisión pendiente

Los hosts descubiertos no entran directo a tu inventario: te esperan en la bandeja de **Revisión
pendiente** arriba de la vista de Servidores, cada uno mostrando su nombre de host, su tipo, de dónde
vino el reporte y hace cuánto reportó por última vez. Para cada uno tenés dos opciones:

- **Confirmar** — suma el host a tu topología activa. Un diálogo breve te permite renombrarlo y
  cambiar su tipo antes, y ofrece un interruptor **Registrar como activo de inventario** (**activado**
  por defecto): si lo dejás activado, lazyit también crea un **activo** registrado con los datos
  reportados del host, así el servidor puede tener responsable, artículos de la base de conocimiento y
  referencias a secretos como cualquier otro activo. Desactivalo para dejar el nodo solo en el grafo.
- **Descartar** — elimina la propuesta. Es un borrado lógico (igual que quitar cualquier nodo del
  mapa): no se destruye nada y se puede restaurar más adelante.

Una vez confirmado, un host sigue recibiendo datos frescos del agente, pero tus ediciones — su
nombre, tipo, posición y conexiones — son tuyas y el agente nunca las sobrescribe.

## Qué recopila el agente

- **Identidad y hardware** — nombre de host, sistema operativo y kernel, CPU y memoria, discos e
  interfaces de red y (solo cuando se ejecuta como root) fabricante / modelo / número de serie.
- **Software instalado** — la lista de paquetes instalados, con versiones cuando están disponibles.

Recopila todo lo que puede y simplemente omite lo que no puede leer, así una instalación sin
privilegios igual reporta una imagen útil. **Nunca** lee secretos, archivos ni datos de aplicaciones,
y no envía métricas.

## Seguridad

- **Un permiso acotado.** El token tiene **solo** `infra:report`. No puede leer ni modificar nada más
  en lazyit — ni activos, ni secretos, ni otra infraestructura. Lo peor que puede hacer un token
  filtrado es crear propuestas que vos descartás.
- **Una compuerta humana.** Todo lo que el agente reporta queda como **Pendiente** y solo pasa a ser
  parte de tu inventario cuando lo confirmás. Un escritor automático nunca puede cambiar tus registros
  oficiales en silencio.
- **Nunca secretos.** El agente no lleva claves ni lee ninguna bóveda — los valores de tus secretos
  quedan intactos.
- **Autoalojado y compatible con redes aisladas.** El comando de instalación apunta a *tu* instancia,
  el agente solo se comunica con esa instancia y funciona totalmente sin conexión. Los tokens se pueden
  revocar en cualquier momento desde [Cuentas de servicio](/help/users-permissions-service-accounts).

## Qué sigue

- [Diagrama de infraestructura](/help/assets-topology-diagram) — el mapa donde aparecen los servidores
  confirmados.
- [Lista de servidores](/help/assets-topology-servers) — la tabla donde vive la bandeja de Revisión
  pendiente.
- [Cuentas de servicio](/help/users-permissions-service-accounts) — gestioná o revocá el token del
  agente.
