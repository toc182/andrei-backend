# Revisión del módulo de requisiciones — resumen para Iván

**De:** Luis Guillén · **Fecha:** 2026-09-01 · **Alcance:** `src/routes/requisiciones.ts` y sus
migraciones (029–033, 117, 120), leídos contra el resto del ERP y contra las prácticas de
procurement en construcción.

## Contexto

Estoy diseñando un proceso de compras para otra plataforma y tomé tu módulo de requisiciones como
punto de partida. Esta nota resume lo que encontré. No es una comparación entre sistemas: es lo que
vi en el código, con la línea donde está, por si te sirve para el ERP.

## Lo que está bien resuelto, y no en requisiciones

El diseño fuerte del ERP está en **solicitudes de pago**, y es lo que voy a tomar como referencia:

- Cadena de aprobadores ordenada por proyecto, con turno (`/:id/aprobar`, línea 3441).
- Re-autenticación con contraseña para aprobar y aprobación masiva verificada.
- Código de verificación único con QR y página pública de verificación (migración 055).
- Corrección post-pago sólo por admin y con motivo obligatorio (`/:id/corregir`, línea 2365).
- Correlativo generado por el servidor con prefijo por proyecto (`generateNumero`).
- Auditoría en `audit_log` y adjuntos en R2 con tabla propia.

## Cuatro huecos de control en requisiciones

| # | Qué | Dónde | Efecto |
|---|---|---|---|
| 1 | El cambio de estado no comprueba rol ni turno: cualquier usuario autenticado pasa una requisición a `aprobada` o `pagada`, incluida la suya | `PATCH /:id/estado`, línea 632 | la aprobación no prueba nada; no hay separación de funciones |
| 2 | Ninguna ruta pasa por `checkProjectAccess`: se lista, lee y crea en cualquier proyecto | todo el archivo | fuga entre proyectos para el rol `usuario` |
| 3 | Crear hace tres `INSERT` sueltos (cabecera, ítems, historial) sin `BEGIN` | `POST /`, línea 312 | una caída a mitad deja una cabecera sin ítems |
| 4 | Cero llamadas a `registrarAudit`, contra la regla de `CLAUDE.md` | todo el archivo | una edición de montos no deja rastro; sólo quedan los cambios de estado |

## Cinco cosas menores

- El número lo teclea el cliente; sólo lo protege el `UNIQUE` de la migración 117. Solicitudes ya
  tiene `generateNumero` y se podría reutilizar.
- ITBMS al 7 % como constante y aritmética en `float` (`subtotal * 0.07`). Si cambia la tasa o entra
  retención, hay que migrar datos.
- `PUT /:id` borra y reinserta los ítems: se pierden los ids y nada puede apuntar a un ítem.
- `DELETE /:id` físico en `pendiente` y `rechazada`, además de `archivar`.
- El cruce con presupuesto no existe: la categoría es opcional por ítem y no hay comprometido. La
  requisición salta de `aprobada` a `pagada` sin orden de compra ni factura entre medio.

## Tres arreglos de bajo costo, si quieres hacerlos

1. En `PATCH /:id/estado`: exigir `requireManager` para `aprobada` y `pagada`, y rechazar
   `aprobado_por === solicitante_id`. Dos líneas.
2. Añadir `checkProjectAccess('proyecto_id')` en crear y `checkProjectAccess` por `id` en el resto,
   como ya hacen otras rutas.
3. Envolver la creación en `BEGIN` / `COMMIT` y llamar a `registrarAudit` en crear, editar,
   cambiar estado y archivar. Es el mismo patrón que `approvalSettings.ts` ya usa.

## Qué me llevo de tu diseño

La cadena de aprobadores, la re-autenticación, la corrección con motivo y el código de verificación
van a la etapa donde sale el dinero (factura y pago), no a la requisición. La petición interna se
queda como eso: solicitud de compra, pre-impuesto, con cargo a partida; y la orden de compra o el
subcontrato es la pieza que falta entre ella y el pago.

Si quieres, lo revisamos juntos.
