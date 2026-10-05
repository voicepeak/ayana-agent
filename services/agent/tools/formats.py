"""Shared file format and private/generated directory rules."""

SKIP = {".git", ".venv", "venv", "node_modules", "dist", "dist-electron", "build", "release", ".runtime", "__pycache__", ".next", "assets"}
TEXT = {".py", ".ts", ".tsx", ".js", ".jsx", ".vue", ".rs", ".md", ".txt", ".toml", ".json", ".yaml", ".yml", ".css", ".html", ".cs", ".go", ".java", ".c", ".cpp", ".h", ".sql", ".csv"}
SOURCE_NAMES = {"Dockerfile", "Makefile", "LICENSE"}
DOCUMENTS = {".pdf", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".rtf"}
MEDIA = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".mp3", ".wav", ".m4a", ".flac", ".mp4", ".mkv", ".mov", ".avi"}
OPENABLE = TEXT | DOCUMENTS | MEDIA


def is_text(path):
    return path.suffix.lower() in TEXT or path.name in SOURCE_NAMES


def is_openable(path):
    return is_text(path) or path.suffix.lower() in OPENABLE
