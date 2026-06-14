import sys
import os
import argparse
import json

# Phase 4: Vision prompt templates for different use cases
VISION_PROMPTS = {
    "default": "Describe this image in detail for documentation purposes.",
    "ocr": "Extract all visible text from this image. Preserve formatting and layout. Output as plain text.",
    "diagram": "Describe this diagram, flowchart, or architectural diagram. Explain the components and their relationships. Use structured markdown.",
    "chart": "Analyze this chart or graph. Describe the type, axes, data series, values, and key insights. Output as markdown table where appropriate.",
    "screenshot": "Describe this UI screenshot. List all visible UI elements (buttons, inputs, labels, menus), layout structure, and text content. Use bullet points.",
    "document": "This is a scanned document. Extract all visible text and describe the document structure, headings, and layout.",
    "technical": "Provide a technical analysis of this image. Focus on technical details, specifications, measurements, and components.",
}

def analyze_document_complexity(file_path):
    """
    Analyze document complexity to recommend the best conversion engine.

    Returns:
        dict: {
            "file_size_mb": float,
            "page_count": int (PDFs only),
            "has_tables": bool (PDFs only),
            "complexity_score": float (0-10),
            "recommended_engine": "docling" | "markitdown"
        }
    """
    if not os.path.exists(file_path):
        return {"error": f"File not found: {file_path}"}

    file_size_bytes = os.path.getsize(file_path)
    file_size_mb = file_size_bytes / (1024 * 1024)
    file_ext = os.path.splitext(file_path)[1].lower()

    complexity_score = 0
    page_count = None
    has_tables = False

    # File size heuristic
    if file_size_mb > 1.0:
        complexity_score += 3

    # PDF-specific analysis
    if file_ext == ".pdf":
        try:
            from docling.document_converter import DocumentConverter

            # Quick metadata extraction without full conversion
            converter = DocumentConverter()
            result = converter.convert(file_path)

            # Check for tables in document structure
            doc_dict = result.document.export_to_dict()
            if "tables" in doc_dict or any("table" in str(item).lower() for item in doc_dict.get("body", [])):
                has_tables = True
                complexity_score += 4

            # Estimate page count from document structure
            if "pages" in doc_dict:
                page_count = len(doc_dict["pages"])
            elif "num_pages" in doc_dict:
                page_count = doc_dict["num_pages"]

            if page_count and page_count > 10:
                complexity_score += 2

        except Exception as e:
            # If Docling analysis fails, use conservative heuristic
            complexity_score += 3  # Assume moderate complexity

    # Excel/CSV with high-fidelity needs → prefer Docling
    if file_ext in [".xlsx", ".xls", ".csv"] and file_size_mb > 0.5:
        complexity_score += 2

    # Recommend engine based on score
    recommended_engine = "docling" if complexity_score >= 5 else "markitdown"

    return {
        "file_path": file_path,
        "file_size_mb": round(file_size_mb, 2),
        "page_count": page_count,
        "has_tables": has_tables,
        "complexity_score": complexity_score,
        "recommended_engine": recommended_engine
    }

def smart_route(file_path, user_preference="auto", high_fidelity=False, require_json=False):
    """
    Determine the best engine based on document analysis.

    Args:
        file_path: Path to document
        user_preference: "auto", "docling", or "markitdown"
        high_fidelity: If True, bias toward Docling
        require_json: If True, force Docling as it supports JSON output

    Returns:
        str: "docling" or "markitdown"
    """
    if user_preference in ["docling", "markitdown"]:
        return user_preference

    # JSON output requires docling
    if require_json:
        return "docling"

    analysis = analyze_document_complexity(file_path)
    if "error" in analysis:
        return "markitdown"  # Safe fallback

    # High-fidelity flag overrides for precision
    if high_fidelity and analysis["complexity_score"] >= 3:
        return "docling"

    return analysis["recommended_engine"]

def main():
    parser = argparse.ArgumentParser(description="Hyperion Bridge: Hybrid Document Conversion (Phase 4: Visual Intelligence)")
    parser.add_argument("file", help="Path to the document to convert")
    parser.add_argument("--engine", choices=["auto", "docling", "markitdown"], default="auto", help="Conversion engine to use")
    parser.add_argument("--json", action="store_true", help="Output in JSON format (if supported by engine)")
    parser.add_argument("--high-fidelity", action="store_true", help="Favor precision over speed")
    parser.add_argument("--analyze", action="store_true", help="Show complexity analysis without converting")

    # Phase 4: Visual Intelligence flags
    parser.add_argument("--describe-images", action="store_true", help="Use LLM to describe images")
    parser.add_argument("--llm-provider", choices=["openai", "anthropic", "google", "local", "azure"], default="openai",
                       help="LLM provider for image description (default: openai)")
    parser.add_argument("--llm-model", type=str, help="Specific LLM model to use (overrides provider default)")
    parser.add_argument("--vision-mode", choices=list(VISION_PROMPTS.keys()), default="default",
                       help="Vision prompt template: " + "|".join(VISION_PROMPTS.keys()))
    parser.add_argument("--vision-prompt", type=str, help="Custom vision prompt (overrides --vision-mode)")

    args = parser.parse_args()

    # Handle --analyze flag
    if args.analyze:
        analysis = analyze_document_complexity(args.file)
        print(json.dumps(analysis, indent=2))
        sys.exit(0 if "error" not in analysis else 1)

    if not os.path.exists(args.file):
        print(f"Error: File not found: {args.file}", file=sys.stderr)
        sys.exit(1)

    # Smart routing with complexity analysis
    engine = smart_route(args.file, args.engine, args.high_fidelity, args.json)

    # Phase 4: Prepare vision parameters
    vision_prompt = args.vision_prompt or VISION_PROMPTS.get(args.vision_mode, VISION_PROMPTS["default"])

    try:
        if engine == "docling":
            run_docling(args.file, args.json)
        else:
            run_markitdown(
                args.file,
                describe_images=args.describe_images,
                llm_provider=args.llm_provider,
                llm_model=args.llm_model,
                vision_prompt=vision_prompt
            )
    except ImportError as e:
        print(f"Error: Engine '{engine}' missing. Please run 'ag-convert --setup' to install dependencies.", file=sys.stderr)
        print(f"Details: {str(e)}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error during conversion: {str(e)}", file=sys.stderr)
        sys.exit(1)

def run_docling(file_path, output_json):
    from docling.document_converter import DocumentConverter
    
    converter = DocumentConverter()
    result = converter.convert(file_path)
    
    if output_json:
        # Docling has a rich document model
        print(json.dumps(result.document.export_to_dict(), indent=2))
    else:
        print(result.document.export_to_markdown())

def get_llm_client_and_model(provider="openai", model=None):
    """
    Phase 4: Get LLM client for image description with multi-provider support.

    Supported providers:
    - openai: GPT-4o, GPT-4-vision
    - anthropic: Claude 3.5 Sonnet
    - google: Gemini Pro Vision
    - local: Ollama with vision models

    Returns: (llm_client, model_name)
    """
    if provider == "openai":
        try:
            from openai import OpenAI
            api_key = os.environ.get("OPENAI_API_KEY")
            if not api_key:
                raise ValueError("OPENAI_API_KEY environment variable not set")
            model = model or "gpt-4o"
            return OpenAI(api_key=api_key), model
        except ImportError:
            raise ValueError("openai package not installed. Install with: pip install openai")

    elif provider == "anthropic":
        try:
            import anthropic
            api_key = os.environ.get("ANTHROPIC_API_KEY")
            if not api_key:
                raise ValueError("ANTHROPIC_API_KEY environment variable not set")
            model = model or "claude-3-5-sonnet-20241022"
            return anthropic.Anthropic(api_key=api_key), model
        except ImportError:
            raise ValueError("anthropic package not installed. Install with: pip install anthropic")

    elif provider == "google":
        try:
            import google.generativeai as genai
            api_key = os.environ.get("GOOGLE_API_KEY")
            if not api_key:
                raise ValueError("GOOGLE_API_KEY environment variable not set")
            genai.configure(api_key=api_key)
            model = model or "gemini-pro-vision"
            return genai, model
        except ImportError:
            raise ValueError("google-generativeai package not installed. Install with: pip install google-generativeai")

    elif provider == "local":
        try:
            import ollama
            model = model or "llava"
            return ollama, model
        except ImportError:
            raise ValueError("ollama package not installed. Install with: pip install ollama")

    elif provider == "azure":
        try:
            from openai import AzureOpenAI
            api_key = os.environ.get("AZURE_OPENAI_API_KEY")
            endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT")
            if not api_key or not endpoint:
                raise ValueError("AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT environment variables not set")
            model = model or "gpt-4o"
            return AzureOpenAI(api_key=api_key, azure_endpoint=endpoint, api_version="2024-02-15-preview"), model
        except ImportError:
            raise ValueError("openai package not installed. Install with: pip install openai")

    else:
        raise ValueError(f"Unsupported LLM provider: {provider}. Supported: openai, anthropic, google, local, azure")

def run_markitdown(file_path, describe_images=False, llm_provider="openai", llm_model=None, vision_prompt=None):
    from markitdown import MarkItDown

    if describe_images:
        try:
            llm_client, model_name = get_llm_client_and_model(llm_provider, llm_model)

            # For MarkItDown, currently only OpenAI is supported natively
            # Other providers would need custom integration
            if llm_provider == "openai":
                md = MarkItDown(llm_client=llm_client, llm_model=model_name)
            else:
                print(f"Note: MarkItDown natively supports OpenAI. Using {llm_provider} requires custom implementation.", file=sys.stderr)
                print("Falling back to basic conversion.", file=sys.stderr)
                md = MarkItDown()
        except (ValueError, ImportError) as e:
            print(f"Warning: {str(e)}", file=sys.stderr)
            print("Falling back to basic conversion without image descriptions", file=sys.stderr)
            md = MarkItDown()
    else:
        md = MarkItDown()

    result = md.convert(file_path)
    print(result.text_content)

if __name__ == "__main__":
    main()
