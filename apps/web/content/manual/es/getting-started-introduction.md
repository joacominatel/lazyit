---
title: Introducción
order: 1
category: getting-started
subcategory: introduction
---

# Introducción

lazyit es el lugar único donde un equipo de IT pequeño gestiona todo lo técnico de una empresa:
inventario de activos, acceso a aplicaciones, consumibles y una base de conocimiento interna. Está
pensado para los generalistas que llevan toda la tecnología de la empresa — la misma persona que
prepara un portátil, aprueba una licencia de SaaS y escribe el runbook para ello.

> Este Manual documenta *lazyit en sí*. La **Base de Conocimiento** dentro de la app documenta *tu
> parque* — tus runbooks, procedimientos y notas. No los confundas: esto es el manual del producto;
> la Base de Conocimiento es la wiki de tu equipo.

## Para quién es

Equipos de IT / Sistemas pequeños, de unas **5 a 20 personas**, que llevan toda la tecnología de una
empresa. lazyit es deliberadamente ligero y opinado: un conjunto curado de capacidades con valores por
defecto sensatos, no mil ajustes que configurar. Si te has ahogado en la sobrecarga de las
herramientas corporativas, ese es el dolor que viene a quitar.

## Qué es lazyit

- **Centrado en el activo.** El **activo** es el ciudadano de primera clase, no la persona. Los
  activos permanecen mientras las personas rotan, así que lazyit registra la propiedad como una
  asignación con fecha, no como una columna del activo. Reasigna o devuelve un activo y el historial
  se conserva automáticamente; "¿quién tuvo este portátil, y cuándo?" siempre tiene respuesta.
- **Autoalojado, de una sola organización.** lazyit se ejecuta dentro de tu empresa — una instancia
  por organización — porque los datos que guarda (inventario, accesos, registros cercanos a
  credenciales) son sensibles. No hay una nube multiinquilino compartida.
- **Auditable por defecto.** Los registros del dominio nunca se borran de forma definitiva; se
  archivan (borrado lógico) y se pueden restaurar. El historial y la actividad se registran a medida
  que trabajas, así que "qué cambió, cuándo y quién" se puede responder después.
- **Unificado.** Inventario, acceso a aplicaciones, consumibles y conocimiento viven en una sola
  herramienta en lugar de dispersos entre hojas de cálculo, historial de chat y la memoria de alguien.

## Qué NO es lazyit

- **No es un sistema de tickets.** lazyit no tiene, a propósito, un pilar de tickets. Está construido
  en torno a objetos de IT — activos, accesos, consumibles, conocimiento — no en torno a tickets y
  colas.
- **No es un portal de cara al cliente.** Es una herramienta interna para tu equipo de IT, no una mesa
  de servicio pública para clientes finales.
- **No es un SaaS multiinquilino.** lazyit se entrega para una sola organización y autoalojado; servir
  a muchos clientes desde una misma instancia compartida queda fuera de alcance.
- **No es tu proveedor de identidad.** lazyit no es dueño de las contraseñas de inicio de sesión. El
  inicio de sesión se delega por OIDC a un proveedor de identidad — el integrado que trae, o el tuyo.
  Consulta [Configuración inicial](/help/getting-started) para la elección.

## Las áreas principales

- **Activos** — el inventario de portátiles, servidores, equipo de red, licencias y todo lo que
  controles, con modelos, categorías, ubicaciones e historial de asignaciones.
- **Usuarios y acceso** — las personas de tu organización, sus roles y a qué aplicaciones llegan.
- **Consumibles** — existencias que vas gastando, como cables y tóner, con movimientos y alertas de
  stock bajo.
- **Base de Conocimiento** — los artículos y runbooks de tu equipo, organizados en carpetas con
  control de acceso.
- **Gestor de Secretos** — bóvedas compartidas y cifradas de extremo a extremo para las credenciales
  que tu equipo tiene en común.

## Pasos siguientes

- Pon en marcha una instancia nueva: [Configuración inicial](/help/getting-started).
- Da de alta a tu equipo: [Usuarios y equipo](/help/getting-started-users-team).
- Trabaja en inglés o español: [Idiomas](/help/getting-started-languages).
