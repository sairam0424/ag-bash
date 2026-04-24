import sys
import os
import argparse
import json

def main():
    parser = argparse.ArgumentParser(description="Hyperion Bridge: Hybrid Document Conversion")
    parser.add_argument("file", help="Path to the document to convert")
    parser.add_argument("--engine", choices=["auto", "docling", "markitdown"], default="auto", help="Conversion engine to use")
    parser.add_argument("--json", action="store_true", help="Output in JSON format (if supported by engine)")
    parser.add_argument("--high-fidelity", action="store_true", help="Favor precision over speed")
    
    args = parser.parse_args()
    
    if not os.path.exists(args.file):
        print(f"Error: File not found: {args.file}", file=sys.stderr)
        sys.exit(1)

    file_ext = os.path.splitext(args.file)[1].lower()
    
    # Selection Logic
    engine = args.engine
    if engine == "auto":
        if file_ext == ".pdf":
            engine = "docling"
        elif file_ext in [".xlsx", ".xls", ".csv"]:
            engine = "docling" if args.high_fidelity else "markitdown"
        else:
            engine = "markitdown"

    try:
        if engine == "docling":
            run_docling(args.file, args.json)
        else:
            run_markitdown(args.file)
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

def run_markitdown(file_path):
    from markitdown import MarkItDown
    
    md = MarkItDown()
    result = md.convert(file_path)
    print(result.text_content)

if __name__ == "__main__":
    main()
