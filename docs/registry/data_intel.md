# Data Intelligence Registry

Ag-Bash includes a suite of high-performance data processing tools compiled to WASM. These allow agents to perform complex analysis without external dependencies.

---

## 📊 Structured Data Tools

### `sqlite3` - Relational Power
A complete SQL engine that supports in-memory databases and file-based state.

**Interactive Test:**
```sql
-- Create and query in one line
echo "CREATE TABLE users(id, name); INSERT INTO users VALUES (1, 'Alice'); SELECT * FROM users;" | sqlite3 :memory:
```

### `jq` - JSON Processing
The industry-standard JSON filter, fully virtualized.

**Interactive Test:**
```bash
echo '{"status": "active", "agent": "Ag-Shell"}' | jq '.agent'
```

### `xan` - CSV/TSV High Performance
A specialized tool for managing tabular data. 

**Interactive Test:**
```bash
# Calculate statistics on a CSV file
echo -e "score\n100\n80\n90" > scores.csv
xan stats scores.csv
```

---

## 🌐 Web & Transformation

### `html-to-markdown` - LLM Parser
Specially optimized for RAG (Retrieval Augmented Generation) pipelines. It transforms messy HTML into clean Markdown that LLMs can easily digest.

**Interactive Test:**
```bash
echo "<h1>Hello World</h1><p>Ag-Bash is great.</p>" | html-to-markdown
```

### `yq` - YAML Master
Process YAML files with the same ease as JSON.

**Interactive Test:**
```bash
echo "version: 1.4.0\nname: Ag-Bash" | yq '.version'
```
