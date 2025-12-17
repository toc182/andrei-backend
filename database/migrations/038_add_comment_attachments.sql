-- Add comment_id column to project_log_attachments to support attachments on comments
ALTER TABLE project_log_attachments
ADD COLUMN IF NOT EXISTS comment_id INTEGER REFERENCES project_log_comments(id) ON DELETE CASCADE;

-- Make entry_id nullable since attachments can now belong to comments instead
ALTER TABLE project_log_attachments
ALTER COLUMN entry_id DROP NOT NULL;

-- Add index for comment attachments
CREATE INDEX IF NOT EXISTS idx_log_attachments_comment ON project_log_attachments(comment_id);
