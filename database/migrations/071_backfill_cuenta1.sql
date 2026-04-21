-- 071_backfill_cuenta1.sql
-- Create cuenta #1 for every project that has no cuentas yet.

INSERT INTO cuentas (proyecto_id, numero, es_final, monto_total, periodo_inicio, estado, created_by)
SELECT p.id, 1, false, 0.00::NUMERIC(14,2), p.fecha_inicio::DATE, 'borrador'::VARCHAR(30), 1
FROM proyectos p
WHERE NOT EXISTS (SELECT 1 FROM cuentas c WHERE c.proyecto_id = p.id)
ON CONFLICT (proyecto_id, numero) DO NOTHING;

INSERT INTO cuentas_eventos (cuenta_id, tipo, comentario, creado_por)
SELECT c.id, 'creacion', 'Período de Cuenta 1 iniciado', 1
FROM cuentas c
WHERE c.numero = 1
  AND NOT EXISTS (SELECT 1 FROM cuentas_eventos ce WHERE ce.cuenta_id = c.id);
