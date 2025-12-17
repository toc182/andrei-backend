-- Migration: Create project bitacora (log) tables
-- Entries, comments, and attachments for project logs

-- Main log entries table
CREATE TABLE IF NOT EXISTS project_log_entries (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    titulo VARCHAR(255),
    contenido TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Comments on log entries
CREATE TABLE IF NOT EXISTS project_log_comments (
    id SERIAL PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES project_log_entries(id) ON DELETE CASCADE,
    contenido TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Attachments (photos/files) for log entries
CREATE TABLE IF NOT EXISTS project_log_attachments (
    id SERIAL PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES project_log_entries(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    filepath VARCHAR(500) NOT NULL,
    mimetype VARCHAR(100),
    size INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_log_entries_project ON project_log_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_log_entries_created ON project_log_entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_log_comments_entry ON project_log_comments(entry_id);
CREATE INDEX IF NOT EXISTS idx_log_attachments_entry ON project_log_attachments(entry_id);
