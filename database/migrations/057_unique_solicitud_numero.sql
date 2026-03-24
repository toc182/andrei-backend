-- 057_unique_solicitud_numero.sql
-- Add unique constraint on (proyecto_id, numero) to prevent duplicate solicitud numbers
-- caused by race condition in generateNumero (see github.com/toc182/andrei-backend/issues/4)
CREATE UNIQUE INDEX IF NOT EXISTS idx_solicitudes_pago_proyecto_numero
ON solicitudes_pago (proyecto_id, numero);
