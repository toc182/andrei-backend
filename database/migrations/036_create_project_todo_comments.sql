-- Migration: Create project_todo_comments table
-- Comments/updates on project todos

CREATE TABLE IF NOT EXISTS project_todo_comments (
    id SERIAL PRIMARY KEY,
    todo_id INTEGER NOT NULL REFERENCES project_todos(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    contenido TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for faster lookups by todo
CREATE INDEX IF NOT EXISTS idx_todo_comments_todo_id ON project_todo_comments(todo_id);

-- Index for ordering by date
CREATE INDEX IF NOT EXISTS idx_todo_comments_created ON project_todo_comments(created_at);
