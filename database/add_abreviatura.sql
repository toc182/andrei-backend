-- Add abreviatura field to clientes table
ALTER TABLE clientes ADD COLUMN abreviatura VARCHAR(25);

-- Add unique constraint for abreviatura (optional but recommended)
ALTER TABLE clientes ADD CONSTRAINT unique_abreviatura UNIQUE (abreviatura);

-- Add index for better performance
CREATE INDEX idx_clientes_abreviatura ON clientes(abreviatura);