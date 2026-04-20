# Core I/O & Filesystem Operations

Ag-Bash provides a POSIX-compliant interface for managing the **OverlayFS** runtime. All operations here are "Virtual-First," meaning they interact with the virtualized layer before falling back to the local host if configured.

---

## 📂 Navigation Tools

### `ls` - List Files
Lists directory contents with support for color, long format (`-l`), and recursion.

**Interactive Test:**
```bash
# List everything in long format
ls -la
```

---

## 📝 File Manipulation

### `touch` - Create Empty File
Creates a new file in the memory-only Overlay layer.

**Interactive Test:**
```bash
touch virtual_note.txt && ls virtual_note.txt
```

### `rm` - Absolute Deletion (Virtual Only)
Removes a file from the virtual view. Note that Ag-Bash **never** deletes files from your actual hard drive unless explicitly un-sandboxed.

**Interactive Test:**
```bash
rm virtual_note.txt && ls virtual_note.txt
# Output: ls: virtual_note.txt: No such file or directory
```

---

## 🔍 Data Inspection

### `cat` - Concatenate & Print
Standard tool for viewing file contents.

**Interactive Test:**
```bash
echo "Hello, Ag-Bash" > greeting.txt
cat greeting.txt
```

### `stat` - File Metrics
Provides detailed metadata about file size, permissions, and timestamps.

**Interactive Test:**
```bash
stat greeting.txt
```
