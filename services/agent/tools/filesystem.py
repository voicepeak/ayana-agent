"""Shared file access API; specialized readers and scanners own their state."""
from .text_reader import READ_LIMIT, read_text
from .traversal import FileBrowser
