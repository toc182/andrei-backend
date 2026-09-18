-- 173_reporte_semanal_problema_pendiente.sql
-- Un problema de la semana que todavía hay que seguir.
--
-- Ivan lo pidió el 2026-09-18, después de leer el primer reporte semanal de
-- verdad: «un problema pudo ser el lunes, que se resolvió el miércoles, pero el
-- semanal lo hace ver como si todavía no se hubiera resuelto».
--
-- No se marca «resuelto» —había atrasos que no se resuelven, que solo son el
-- comentario de ese día—, sino lo contrario y solo cuando toca: `pendiente`
-- nace en false y se enciende únicamente en lo que hay que seguir. Así, la
-- lluvia del miércoles se queda como lo que fue y el material que faltó sale
-- primero y marcado en el papel.
ALTER TABLE proyecto_reporte_semanal_problemas
  ADD COLUMN IF NOT EXISTS pendiente BOOLEAN NOT NULL DEFAULT FALSE;
