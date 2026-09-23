-- 174_reporte_semanal_problema_sin_contestar.sql
-- «Sigue pendiente» pasa de sí/no a sí/no/sin contestar.
--
-- Ivan lo pidió el 2026-09-22, leyendo el primer reporte semanal de verdad
-- (RS-PBR-260914): la sección Problemas listaba cuatro problemas sin decir cuál
-- seguía vivo, así que para saberlo había que llamar al ingeniero. «Si el
-- problema no era necesario mencionarlo en este reporte, mejor quitarlo.»
--
-- Por eso la columna deja de tener valor por omisión: un problema nace SIN
-- CONTESTAR y el reporte no se puede guardar ni enviar mientras alguno lo esté
-- (la regla vive en routes/proyectoReportesSemanales.ts, no solo en la
-- pantalla). La IA sí lo contesta cuando redacta —decisión de Ivan del
-- 2026-09-23: «si la IA puede determinar algo, que lo haga; queda en borrador
-- para que el ingeniero lo cambie»—, así que en la práctica solo queda en
-- blanco lo que se agrega a mano.
--
-- Los reportes que ya salieron no cambian: sus filas siguen con true o false.
ALTER TABLE proyecto_reporte_semanal_problemas
  ALTER COLUMN pendiente DROP DEFAULT,
  ALTER COLUMN pendiente DROP NOT NULL;
