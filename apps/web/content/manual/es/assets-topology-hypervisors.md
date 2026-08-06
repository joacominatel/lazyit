---
title: Hosts hipervisores
category: assets
subcategory: topology
order: 4
---

# Hosts hipervisores

Si una máquina de tu parque **es** un hipervisor — un nodo Proxmox VE, un servidor Hyper-V, un
equipo Linux ejecutando KVM a través de libvirt — el
[agente de reporte](/help/assets-topology-reporting-agent) instalado en ella hace una cosa más:
reporta **los invitados que ese host ejecuta**, de modo que las máquinas virtuales y contenedores
que viven en él aparecen en tu mapa sin necesitar un agente dentro de cada uno, conectados a su host
por el enlace **runs-on** que da sentido al radio de impacto.

No hay nada que configurar para esto. Instalas **el mismo agente, con el mismo comando de una
línea**, en el host hipervisor exactamente igual que en cualquier otro servidor — sin token de API,
sin credencial adicional, sin un recolector aparte que activar. El agente detecta por sí mismo que
está corriendo sobre un hipervisor y empieza a incluir la lista de invitados en sus informes
normales; el instalador imprime lo que detectó (*"Detectado: Proxmox VE — se inventariarán las VMs
QEMU y los contenedores LXC de este host"*) para que lo sepas antes de que llegue el primer informe.
La detección se repite en **cada** informe, así que una máquina que se convierte en hipervisor más
tarde — habilitas el rol de Hyper-V, instalas Proxmox — simplemente empieza a reportar sus invitados
en el siguiente check-in, sin reinstalar nada.

Funciona en:

- **Proxmox VE** — máquinas virtuales QEMU *y* contenedores LXC, leídos localmente en el propio nodo.
- **Hyper-V** — a través del agente de Windows ya presente en el host.
- **libvirt/KVM** — un host Linux genérico ejecutando máquinas virtuales bajo libvirt.

> La lista de invitados sigue siendo la máquina local describiéndose a sí misma — el host
> preguntándole a su **propio** hipervisor qué está ejecutando, igual que un host Docker reporta sus
> propios contenedores. El agente nunca escanea tu red y nunca llama a una API de hipervisor remota.

**VMware es la excepción honesta: los hosts ESXi no pueden ejecutar agentes** — la plataforma no
permite instalar software de terceros en el propio hipervisor — **y el soporte de vCenter está
planificado como una conexión del lado del servidor**, configurada en lazyit en lugar de instalada en
un host. Hasta que eso llegue, los invitados de VMware aparecen como aparecía todo antes de los
agentes: ejecuta el agente dentro de los invitados que te importan, o agrégalos a mano.

Vale la pena nombrar una plataforma más: en **XCP-ng / XenServer** el agente *detecta* el hipervisor
y lo dice, pero todavía no recolecta sus invitados — un honesto "detectado, no inventariado" es mejor
que una lista a medias.

## Qué aparece, y dónde

Cada invitado que el host reporta llega a la bandeja de **Revisión pendiente** de la vista de
Servidores — la misma bandeja, las mismas reglas que cualquier descubrimiento — agrupado bajo su host
hipervisor, y conectado a él en el mapa por un enlace **runs-on** una vez confirmado. Nada entra a tu
inventario en vivo hasta que lo confirmas, de a uno o [en lote](/help/assets-topology-servers).

- Un **invitado QEMU, Hyper-V o libvirt** se propone como nodo de **máquina virtual**; un
  **contenedor LXC de Proxmox** se propone como nodo de **contenedor**.
- Un invitado se identifica por el identificador estable de la propia plataforma (el VMID de Proxmox,
  el GUID de VM de Hyper-V, el UUID de dominio de libvirt), así que renombrar una VM no crea un
  duplicado.
- Como los contenedores, los invitados **por defecto no se registran como activos** al confirmarlos —
  un host de tamaño modesto puede cargar docenas — y el interruptor está ahí mismo si una VM es algo
  que sí registras.
- Un invitado que **desaparece del informe del host** — eliminado, o migrado a otro nodo — queda con
  su nodo marcado **offline**. Nunca se elimina a tus espaldas; Descartar sigue siendo tu decisión, y
  el mismo invitado al volver pone su nodo online de nuevo.
- En un **clúster Proxmox**, cada nodo reporta solo **sus propios** invitados, así que un clúster
  donde cada nodo lleva el agente cubre todo el parque sin solapamientos.

Un host cargado puede proponer mucho de una vez. Los invitados entran por los mismos límites de
descubrimiento que todo lo demás, así que un host con cientos de VMs llena la bandeja **gradualmente
durante una o dos horas** en su primer informe, en lugar de todo en una ráfaga — eso es la protección
contra inundación funcionando, no invitados perdiéndose.

## Una máquina, un nodo

La duda obvia: si una VM ejecuta su **propio** agente *y* su hipervisor la reporta, ¿terminas con dos
nodos para una máquina? No — **convergen automáticamente**. El hipervisor conoce la identidad de
firmware de cada invitado (su UUID SMBIOS) y las direcciones de sus tarjetas de red; el agente dentro
del invitado reporta los mismos hechos desde el otro lado. Cuando ambos coinciden — la identidad
**corroborada** por una dirección de tarjeta de red, nunca por una sola señal — lazyit pliega la
vista del host dentro del nodo propio del invitado: el registro del agente interno gana (tiene el
inventario real — el software, los discos, la identidad de la máquina), y el enlace **runs-on**
aterriza sobre él. Terminas con un solo nodo que sabe tanto qué ejecuta *como* dónde se ejecuta.

Cuando la corroboración no está — las VMs clonadas realmente traen identidades de firmware
duplicadas — las dos filas se muestran como **posible duplicado** para que las revises y fusiones tú,
nunca se fusionan por ti.

Un invitado **sin** agente propio queda representado simplemente por la vista del host: un nodo
confirmable, registrable como activo, que pasa a offline cuando el invitado lo hace. Si más adelante
instalas un agente dentro, los dos convergen de la misma manera.

### Cuando un invitado se queda como dos filas

A veces la fusión automática **no puede** ocurrir, y ahora lazyit te lo dice en vez de quedarse
callado. La fusión automática necesita el **UUID de firmware** del invitado, reportado por el agente
que corre *dentro* de él. Cuando ese agente no reporta UUID de firmware, lazyit cae a comparar la
**tarjeta de red** — y una tarjeta de red sola es una sugerencia, nunca una fusión. Verás una
notificación de **posible duplicado** diciendo que una tarjeta de red coincide pero no hay UUID que
lo confirme.

La notificación te dice **cuál de las tres causas** tienes delante, porque el arreglo es distinto en
cada una:

- **Un contenedor (LXC).** Los contenedores no tienen UUID de firmware propio — no hay nada que
  leer, con ningún nivel de privilegio. Este par solo se cierra **a mano**, y está bien así: fusionas
  una vez y queda resuelto.
- **Un agente corriendo sin privilegios.** En Linux el UUID de firmware solo lo puede leer `root`,
  así que un agente que corre como usuario normal simplemente lo omite. **Ejecuta el agente como
  root** (o como Administrador en Windows) y las dos filas convergen solas desde el siguiente
  informe — sin fusionar nada.
- **Una VM cuyo firmware Windows no puede leer.** Algunas máquinas virtuales presentan su firmware
  de una forma que **Windows no puede localizar**, así que Windows no reporta ningún UUID SMBIOS. Es
  habitual en **Proxmox VE** y solo con invitados **Windows**: Proxmox congela la versión del
  hardware virtual de una VM Windows en el momento en que la creas, así que una VM creada en PVE 8.1
  u 8.2 conserva ese hardware para siempre mientras las VMs Linux de al lado no se ven afectadas.
  Sube la versión de **Machine** de la VM (VM → Hardware → Machine) a una actual, o agrega
  `-machine smbios-entry-point-type=32` a sus `args`, y reinicia el invitado — las dos filas
  convergen por su cuenta a partir del siguiente informe.

En cualquiera de los casos también puedes simplemente **fusionarlas una vez, desde la bandeja**:
**Fusionar en…** pliega la fila del hipervisor dentro del nodo propio del invitado, conservando todo
lo que configuraste.

**¿Actualizando a esta versión?** El primer informe de cada host levantará estas notificaciones para
pares que ya estaban divididos en silencio — estás viendo aflorar duplicados existentes, no
creándose nuevos. Las filas que ya se bifurcaron **no se fusionan solas**. Recibes una notificación
por (invitado, tarjeta de red), no una por informe, así que cada par suena una vez y luego se queda
callado — pero si tu parque tiene **muchos contenedores LXC con agente propio**, o **muchos agentes
sin privilegios**, espera que esa primera oleada sea grande, porque cada uno de esos pares es
genuinamente imposible de fusionar de forma automática.

## Migraciones en el clúster

Cuando una VM **migra entre nodos de un clúster Proxmox**, el nodo A deja de reportarla y el nodo B
empieza — así que su nodo viejo queda **offline** bajo A y una **nueva propuesta pendiente** aparece
bajo B. lazyit nota que las dos parecen la misma máquina y muestra la **sugerencia de posible
duplicado** en el diálogo de fusión; **Fusionar en…** las pliega en una, conservando todo lo que
configuraste. Es deliberadamente una *sugerencia* de un clic y no una fusión automática — una fusión
equivocada es cara, una sugerencia es barata. Un invitado que ejecuta su propio agente se salta todo
esto: su único nodo canónico simplemente ve su enlace runs-on re-apuntado al nuevo host.

## Cómo desactivarlo

El inventario de invitados sigue los mismos tres controles que cualquier otro recolector, y el
apagado siempre le gana al encendido:

- **Al instalar** — agrega `--no-hypervisor` al comando de instalación de Linux, o `-NoHypervisor` en
  Windows. Esto escribe por ti el veto de abajo en la configuración del host.
- **En el host** — establece `LAZYIT_COLLECT_HYPERVISOR=false` en el archivo de configuración del
  propio agente (`/etc/lazyit-agent/config` en Linux, `C:\ProgramData\lazyit-agent\config` en
  Windows). Como todo ajuste local, esto **prevalece sobre cualquier cosa configurada en lazyit** y
  sobrevive a las actualizaciones del agente.
- **Centralmente** — el interruptor **Invitados del hipervisor** en **Configuración → Agentes de
  reporte**, que lo apaga para todos los agentes del parque en su siguiente check-in. Está
  **activado por defecto**: la detección ya condiciona la recolección, así que en un host que no es
  hipervisor el interruptor no cambia nada.

Desactivarlo detiene los informes de invitados futuros; los nodos de invitados que ya confirmaste
quedan donde están, pasando a offline a medida que sus informes cesan, y Descartar sigue siendo tuyo.

> El agente lee la **lista** de invitados — nombres, identidades, estado, dimensionamiento — nunca su
> contenido. No mira dentro de los discos de un invitado, no necesita ningún agente ni herramienta
> instalada en los invitados, y no envía métricas. Es inventario, en el mismo sentido estrecho que
> todo lo demás que hace el agente.
