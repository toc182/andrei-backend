-- 189_caja_menuda_activo.sql
--
-- Una caja menuda se puede quitar sin borrarla. Hasta ahora no habia manera:
-- la caja «Caja Menuda N. 9 (Periodo 22/7/26 AL 15/9/26)» de Tuberias se
-- registro por error —sus 16 gastos son los mismos que se reembolsaron en
-- Santa Isabel con STAISA-017M— y lo unico que el sistema dejaba hacer era
-- borrar sus gastos uno por uno, que es perderlos (Ivan, 2026-11-18: «hay que
-- eliminar esa N.9, parece un error»).
--
-- Una caja quitada (activo = false) no sale en las listas, no se abre, no
-- recibe gastos ni reembolsos, y no cuenta en Control de Costos. Sus gastos,
-- archivos e historial se quedan guardados; quien la quito y por que queda en
-- audit_log.

ALTER TABLE cajas_menudas ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT true;
