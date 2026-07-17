-- 141_desglose_itbms.sql
-- Optional ITBMS on the official desglose. NULL = sin ITBMS; a value = the tax
-- rate (%) applied to the whole subtotal at display time. Totals are never
-- stored (see 138); only the rate is persisted.
ALTER TABLE desgloses ADD COLUMN IF NOT EXISTS itbms_tasa NUMERIC(5,2);
