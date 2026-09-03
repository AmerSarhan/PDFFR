# Mixed Document

Page one is born-digital. Page two is a scanned bitmap with no text layer. Page three mixes native text with an embedded scanned insert.

# Quarterly Operations Review

## Executive Summary

Throughput rose 14% quarter over quarter while unit cost held flat. This document was produced natively, so every glyph carries an exact coordinate that the decompiler reads directly. No page image is ever rendered for this text.

Bold lead-in. The remainder of this sentence is regular weight and continues here.

## Key Actions

- Re-thread reading order across multi-column layouts
- Reconstruct tables from column alignment
- Flag scanned pages for OCR instead of guessing

## Regional Performance

| Region | Units | Change |
| ------ | ----- | ------ |
| North  | 4,210 | +12%   |
| South  | 3,880 | +9%    |
| West   | 5,120 | +18%   |

## Native Text With Scanned Insert

The paragraph you are reading is native. The block below is a bitmap of a scanned page, which the render-diff oracle should isolate and OCR.

Quarterly Operations Review

Executive Summary

Throughput rose 14% quarter over quarter while unit cost held flat. This document was produced natively, so every glyph carries an exact coordinate that the decompiler reads directly. No page image is ever rendered for this text.

Bold lead-in. The remainder of this sentence is regular weight and continues here.

Key Actions

- Re-thread reading order across multi-column layouts
- Reconstruct tables from column alignment
- Flag scanned pages for OCR instead of guessing

Regional Performance

| Region | Units | Change |
| ------ | ----- | ------ |
| North  | 4,210 | +12%   |
| South  | 3,880 | +9%    |
| West   | 5,120 | +18%   |

And this closing line is native again, after the insert.
