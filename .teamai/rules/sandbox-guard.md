# Sandbox Guard Rules
- BLOCK & TRIGGER DANGER_GATE:
  - `rm -rf /` or destructive root wildcards
  - `DROP TABLE` / `DROP DATABASE`
  - `git push --force` / `git push -f`
  - Read/Write outside assigned worktree or accessing `.env*`, `~/.ssh/`, `/etc/`