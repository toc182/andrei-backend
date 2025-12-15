-- Migration 033: Add archivada field to requisiciones
-- Implements soft delete for requisiciones (archive instead of permanent delete)

-- Add archivada column
ALTER TABLE requisiciones
ADD COLUMN IF NOT EXISTS archivada BOOLEAN DEFAULT FALSE;

-- Add fecha_archivado for tracking when it was archived
ALTER TABLE requisiciones
ADD COLUMN IF NOT EXISTS fecha_archivado TIMESTAMP;

-- Add archivado_por to track who archived it
ALTER TABLE requisiciones
ADD COLUMN IF NOT EXISTS archivado_por INTEGER REFERENCES users(id);

-- Create index for filtering non-archived requisiciones
CREATE INDEX IF NOT EXISTS idx_requisiciones_archivada ON requisiciones(archivada);

-- Update existing requisiciones to not be archived
UPDATE requisiciones SET archivada = FALSE WHERE archivada IS NULL;
