---
title: Patrones recomendados
category: security-best-practices
subcategory: recommended-patterns
order: 4
---

# Patrones recomendados

Un conjunto breve y con criterio de hábitos que mantienen una instancia de lazyit ordenada y segura.
Ninguno de ellos está forzado por el sistema — son los patrones que funcionan bien para un equipo de
IT pequeño.

## Nombra las cosas de modo que el nombre no filtre nada

Algunas etiquetas en lazyit son **visibles para más personas que los datos que hay detrás**. En el
Gestor de Secretos, el **nombre** de una bóveda y su **lista de miembros**, y la **etiqueta** de un
secreto, son visibles como metadatos aunque el *valor* del secreto esté cifrado y el servidor no pueda
leerlo. Por eso:

- **Nombra una bóveda por su alcance, no por su contenido** — "Equipos de red de producción", no la
  contraseña real.
- **Etiqueta un secreto por lo que es** — "Acceso de administración del switch central" — nunca
  poniendo el valor en la etiqueta.

El mismo instinto aplica en todo el producto: elige nombres que le sirvan a un compañero pero que sean
inofensivos para un lector casual.

## Carpetas de la Base de Conocimiento: estructura el acceso, no lo espolvorees

El acceso a la Base de Conocimiento se limita a **carpetas**, no a artículos individuales. Apóyate en
eso:

- **Decide el acceso a nivel de carpeta.** Pon en la misma carpeta los artículos que comparten
  audiencia y define el acceso de la carpeta una vez, en lugar de razonar sobre cada artículo.
- **Hereda y luego restringe.** Una subcarpeta puede ser más restringida que su carpeta padre, pero
  nunca más amplia — construye tu árbol de modo que lo más sensible quede más profundo, bajo una
  carpeta más estricta.
- **Por defecto, abierto para los runbooks generales; restringe los pocos que lo necesiten.** La
  mayor parte de la documentación se beneficia de ser encontrable. Reserva las carpetas restringidas
  para lo genuinamente sensible.
- **Recuerda que los enlaces no amplían el acceso.** Referenciar o enlazar un artículo nunca permite a
  alguien ver algo que de otro modo no podría — así que organiza para la claridad y deja que las
  reglas de acceso hagan el control.

## Higiene de la membresía de bóvedas

Las bóvedas son la unidad de compartición de secretos — trata la membresía como algo que curas, no
como algo que simplemente se acumula:

- **Nunca dejes una bóveda importante con un solo miembro.** Una bóveda de un solo miembro está a una
  clave de recuperación perdida de la pérdida permanente. Agrega un segundo miembro de confianza a
  todo lo que importe; atiende el aviso de un solo miembro de lazyit.
- **Limita una bóveda a un grupo real.** Una bóveda para "el equipo de red" con los miembros
  correctos es mejor que una bóveda gigante en la que está todo el mundo. Menos miembros significa un
  radio de impacto menor si uno queda comprometido.
- **Revisa la membresía cuando alguien cambia de rol o se va.** Quitar a un miembro detiene su acceso
  futuro. Si el secreto en sí pudo quedar expuesto, además **rota la credencial subyacente** —
  consulta [Seguridad operativa](/help/security-best-practices-operational-security).
- **Comparte agregando miembros, no copiando secretos por ahí.** El sentido de una bóveda es,
  justamente, que concedes acceso sin que el valor salga nunca de su forma cifrada.

## Delegación: prefiere permisos concretos antes que roles grandes

Cuando alguien necesita hacer un poco más de lo que su rol permite, resiste el impulso de convertirlo
en administrador:

- **Concede el permiso concreto a Miembro o Lector** en vez de ascender a administrador. Administrador
  es todo o nada y no se puede restringir.
- **Mantén el grupo de administradores pequeño y revisado.** Un puñado de administradores es más sano
  que una docena.
- **Usa una cuenta de servicio para automatizar**, no las credenciales de una persona ni un inicio de
  sesión de administrador compartido. Dale a cada una su propio token de alcance estrecho, y rótalo si
  queda expuesto.

Consulta [Principios de control de acceso](/help/security-best-practices-access-control-principles)
para el razonamiento detrás de esto, y [Permisos](/help/permissions) para ver cómo ajustar de verdad
lo que pueden hacer Miembro y Lector.

## Un resumen en una línea

**Mínimo acceso, claves de recuperación fuera del host, bóvedas con varios miembros, nombres
inofensivos y rota la credencial real ante la duda.** Acierta en esos cinco y el resto se sigue solo.
