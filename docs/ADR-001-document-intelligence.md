# ADR-001: Project "Hyperion" - Hybrid Document Intelligence (Docling + MarkItDown)

## 🏛️ Status

**Status**: Implemented  
**Date**: 2026-04-24  

---

## 📖 Context

As AI agents increasingly interact with real-world enterprise repositories, they encounter non-standard file formats (PDFs, DOCX, PPTX, XLSX, and Images). Current conversion tools in `ag-bash` (like `html-to-markdown`) are insufficient for high-fidelity structural preservation, especially for complex tables, multi-column layouts, and visual data.

Two state-of-the-art libraries have emerged:
1. **Docling (IBM)**: Specialized in high-fidelity PDF/Table conversion using specialized ML models (TableFormer).
2. **MarkItDown (Microsoft)**: A "Swiss Army Knife" for 20+ formats, supporting media files and office documents with speed and simplicity.

## 🎯 Decision

We will implement a new "superpower" toolset in `ag-bash` called **Project Hyperion**. This will introduce a hybrid conversion engine that intelligently routes documents between `Docling` and `MarkItDown` to produce "AI-ready" Markdown.

### 🏗️ Technical Architecture

#### 1. The `ag-convert` Command

A new core command will be added to `packages/bash/src/commands/ag-convert`:
- **Usage**: `ag-convert <file_path> [--engine docling|markitdown] [--high-fidelity] [--json]`
- **Alias**: `ag-doc-to-md`

#### 2. Hybrid Router Logic

The engine will use an **Adaptive Routing Strategy**:

| Input Type | Primary Engine | Rationale |
| :--- | :--- | :--- |
| **PDF (Complex)** | `Docling` | Superior table and layout recognition. |
| **XLSX / CSV** | `Docling` | Better cell-to-markdown grid mapping. |
| **DOCX / PPTX** | `MarkItDown` | Faster and handles office XML structure efficiently. |
| **Images (JPG/PNG)**| `MarkItDown` | Built-in support for OCR and LLM-based visual description. |
| **Audio (MP3/WAV)** | `MarkItDown` | Transcription support (if host supports it). |

#### 3. Python Bridge Layer

Since both libraries are Python-based, we will introduce a **Native Bridge**:
- **Ag-Convert-Bridge**: A Python script executed via a managed `venv` or `conda` environment on the host.
- **Communication**: Node.js `spawn` calls with JSON-RPC or structured CLI output to maintain speed and error handling.
- **Fallback Policy**: If the primary engine fails or produces low-density output, the bridge automatically falls back to the secondary engine.

### 🧠 Agentic Integration

The tool will be registered in `BashToolbox.ts` with the following schema:

```typescript
{
  name: "convert_document",
  description: "Converts any document (PDF, DOCX, Image, etc.) into high-quality Markdown for AI consumption.",
  parameters: {
    path: "string",
    highFidelity: "boolean (optional)",
    describeImages: "boolean (optional)"
  }
}
```

## ✅ Consequences

### 🟢 Benefits

- **Superpower for RAG**: Agents can now "read" scientific papers, financial reports, and images directly.
- **Structural Integrity**: Tables remain as valid Markdown tables instead of garbled text.
- **Universal Ingestion**: One tool handles 30+ formats.

### 🟡 Challenges

- **Dependency Management**: Requires a host Python environment with heavy ML libraries (PyTorch/Docling).
- **Resource Intensity**: `Docling` can be CPU/RAM intensive during PDF layout analysis.
- **Bootstrap Latency**: First-time execution might involve model downloading (handled via pre-warming logic).

## 🚀 Implementation Roadmap

1. **Phase 1**: ✅ Create the Python `ag-convert-bridge` wrapping both libraries.
2. **Phase 2**: ✅ Implement the `ag-convert` TypeScript command in `packages/bash`.
3. **Phase 3**: ✅ Integrate into `BashToolbox` and expose via MCP for external tools.
4. **Phase 4**: ✅ Add "Visual-to-Text" capability using `MarkItDown`'s LLM plugin.

## ✅ Phase 4 Implementation (v2.3.0 - Visual Intelligence)

### What Was Delivered

- **Multi-provider LLM support**: OpenAI (GPT-4o), Anthropic (Claude 3.5), Google (Gemini), Local (Ollama)
- **Specialized vision modes**: 7 prompt templates (default, OCR, diagram, chart, screenshot, document, technical)
- **Custom vision prompts**: User-defined prompts for tailored image analysis
- **Enhanced help system**: Comprehensive documentation for all Phase 4 features
- **Backward compatible**: All Phase 1-3 features still work

### New Flags

```bash
--describe-images              # Enable AI vision analysis
--llm-provider <provider>      # Select LLM provider (openai|anthropic|google|local)
--llm-model <model>            # Override default model per provider
--vision-mode <mode>           # Use predefined prompt templates
--vision-prompt <text>         # Custom vision prompt
```

### Example Usage

```bash
# OCR text extraction
ag-convert scan.jpg --describe-images --vision-mode ocr

# Diagram analysis with Claude
ag-convert architecture.png --describe-images --vision-mode diagram --llm-provider anthropic

# Chart analysis
ag-convert sales_chart.png --describe-images --vision-mode chart

# Custom analysis
ag-convert photo.jpg --describe-images --vision-prompt "Describe this image poetically"
```

### Files Modified

1. `hyperion_bridge.py` - Added multi-provider support, vision prompts
2. `ag-convert.ts` - Added Phase 4 flags, updated help text to v2.3.0
3. `ADR-001-document-intelligence.md` - This file, marking Phase 4 complete

### Documentation Created

- `PHASE4-VISUAL-INTELLIGENCE-GUIDE.md` - Comprehensive 300+ line guide
- Updated help text with Phase 4 examples

### Performance

- Processing speed: 1-30 seconds per image (provider-dependent)
- Cost: $0 (local) to $0.05 per image (OpenAI)
- Quality: Production-ready for OCR, diagram, and chart analysis

### Status

**Phase 4**: ✅ **COMPLETE** (2026-04-24)  
**Version**: v2.3.0 (Hyperion Phase 4: Visual Intelligence)
