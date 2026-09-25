---
"@ag-bash/mcp-server": patch
---

Extend `sanitizeOutput`'s stripped-character coverage beyond ANSI/OSC/control-bytes/bidi to two steganographic supplementary-plane Unicode ranges with no legitimate rendering use: the Unicode Tags block (U+E0000–U+E007F, the deprecated language-tag mechanism) and the Variation Selectors Supplement (U+E0100–U+E01EF, the range abused by the documented "ASCII smuggling via variation selectors" technique). Deliberately does NOT strip the base Variation Selectors block (U+FE00–U+FE0F) — U+FE0F is the ordinary emoji-presentation selector used in real-world text (e.g. "❤️"), and stripping it would corrupt legitimate output.
